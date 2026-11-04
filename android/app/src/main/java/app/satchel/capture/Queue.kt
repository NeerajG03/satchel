package app.satchel.capture

import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * One capture waiting to reach the Shelf. `stage` is how far it got, saved
 * after every step, so a capture picks up where it stopped and no step ever
 * runs before the one before it was confirmed.
 */
data class QueuedItem(
    val id: String,
    val kind: String,            // note, photo or voice
    val note: String,
    val objectPath: String?,     // <owner id>/<item id>.<ext>, set once signed in
    val mime: String?,
    val size: Int?,
    val stage: Int = ADD,
    val createdAt: Long = System.currentTimeMillis(),
    val problem: String? = null,
    // What the person said about a photo: a second file on the same item.
    val voicePath: String? = null,
    val voiceMime: String? = null,
    val voiceSize: Int? = null,
) {
    companion object {
        const val ADD = 0
        const val UPLOAD = 1
        const val READ = 2
    }
}

/** The Shelf takes these; anything else is refused before it is queued. */
object ShelfTypes {
    const val NOTE_LIMIT = 4000
    const val BYTE_LIMIT = 20 * 1024 * 1024
    private val extensions = mapOf(
        "image/jpeg" to "jpg", "image/png" to "png", "image/webp" to "webp", "image/heic" to "heic",
        "audio/webm" to "webm", "audio/mp4" to "m4a", "audio/mpeg" to "mp3", "audio/wav" to "wav", "audio/ogg" to "ogg",
    )
    fun extension(mime: String) = extensions[mime]
    fun takes(mime: String) = mime in extensions
}

/** Captures as folders on the phone: meta.json plus the file. Nothing here touches the network. */
class Queue(private val root: File) {
    init { root.mkdirs() }

    fun addNote(text: String): QueuedItem =
        save(QueuedItem(UUID.randomUUID().toString(), "note", text.take(ShelfTypes.NOTE_LIMIT), null, null, null), null)

    /** The bytes are final here: the size written on the row is the size that is uploaded. */
    fun addFile(kind: String, mime: String, bytes: ByteArray, note: String = ""): QueuedItem {
        require(ShelfTypes.takes(mime)) { "The Shelf does not take $mime" }
        require(bytes.size in 1..ShelfTypes.BYTE_LIMIT) { "That file is over 20 MB" }
        val item = QueuedItem(UUID.randomUUID().toString(), kind, note.take(ShelfTypes.NOTE_LIMIT), null, mime, bytes.size)
        return save(item, bytes)
    }

    /** A photo and what was said about it, as one item. */
    fun addPhotoWithVoice(photo: ByteArray, voice: ByteArray, note: String = ""): QueuedItem {
        require(photo.size in 1..ShelfTypes.BYTE_LIMIT && voice.size in 1..ShelfTypes.BYTE_LIMIT) { "That file is over 20 MB" }
        val item = QueuedItem(UUID.randomUUID().toString(), "photo", note.take(ShelfTypes.NOTE_LIMIT), null, "image/jpeg", photo.size,
            voiceMime = "audio/mp4", voiceSize = voice.size)
        val dir = File(root, item.id).apply { mkdirs() }
        File(dir, "voice").writeBytes(voice)
        return save(item, photo)
    }

    fun pending(): List<QueuedItem> = (root.listFiles() ?: emptyArray())
        .mapNotNull { dir -> File(dir, "meta.json").takeIf { it.exists() }?.let { read(it) } }
        .sortedBy { it.createdAt }

    fun file(item: QueuedItem): File = File(File(root, item.id), "data").also { if (!it.exists()) throw java.io.FileNotFoundException(item.id) }
    fun voice(item: QueuedItem): File = File(File(root, item.id), "voice").also { if (!it.exists()) throw java.io.FileNotFoundException(item.id) }

    fun update(item: QueuedItem): QueuedItem = item.also { write(File(File(root, it.id), "meta.json"), it) }

    fun remove(item: QueuedItem) { File(root, item.id).deleteRecursively() }

    fun clear() { root.listFiles()?.forEach { it.deleteRecursively() } }

    private fun save(item: QueuedItem, bytes: ByteArray?): QueuedItem {
        val dir = File(root, item.id).apply { mkdirs() }
        if (bytes != null) File(dir, "data").writeBytes(bytes)
        write(File(dir, "meta.json"), item)
        return item
    }

    private fun write(file: File, item: QueuedItem) {
        if (!file.parentFile!!.exists()) throw java.io.FileNotFoundException(item.id)
        val o = JSONObject().put("id", item.id).put("kind", item.kind).put("note", item.note)
            .put("objectPath", item.objectPath ?: JSONObject.NULL).put("mime", item.mime ?: JSONObject.NULL)
            .put("size", item.size ?: JSONObject.NULL).put("stage", item.stage)
            .put("createdAt", item.createdAt).put("problem", item.problem ?: JSONObject.NULL)
            .put("voicePath", item.voicePath ?: JSONObject.NULL).put("voiceMime", item.voiceMime ?: JSONObject.NULL)
            .put("voiceSize", item.voiceSize ?: JSONObject.NULL)
        // Written whole and then moved, so a crash mid-write never leaves half a record.
        val temp = File(file.parentFile, "meta.tmp")
        temp.writeText(o.toString())
        if (!temp.renameTo(file)) throw java.io.IOException("Could not save ${item.id}")
    }

    private fun read(file: File): QueuedItem? = try {
        val o = JSONObject(file.readText())
        fun str(k: String) = if (o.isNull(k)) null else o.getString(k)
        QueuedItem(o.getString("id"), o.getString("kind"), o.getString("note"), str("objectPath"), str("mime"),
            if (o.isNull("size")) null else o.getInt("size"), o.getInt("stage"),
            o.getLong("createdAt"), str("problem"),
            str("voicePath"), str("voiceMime"), if (o.isNull("voiceSize")) null else o.optInt("voiceSize"))
    } catch (e: Exception) { null }
}

/** Sends what is queued, oldest first, one confirmed step at a time. */
class Sender(private val queue: Queue, private val api: ShelfApi, private val ownerId: () -> String?) {
    /** Returns true when everything that can be sent now was sent. One stuck item never holds up the rest. */
    suspend fun run(): Boolean {
        var allSent = true
        val tried = mutableSetOf<String>()
        // Round again while new captures arrive, so a capture made during a send goes in the same run.
        while (true) {
            val fresh = queue.pending().filter { it.problem == null && it.id !in tried }
            if (fresh.isEmpty()) break
            for (start in fresh) {
                tried += start.id
                try {
                    when (send(start)) {
                        Outcome.SENT -> {}
                        Outcome.LATER -> allSent = false
                        Outcome.SIGNED_OUT -> return false
                    }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: java.io.FileNotFoundException) {
                    // Cleared from the phone while this run was holding it.
                } catch (e: Exception) {
                    runCatching { queue.update(start.copy(problem = "Satchel could not read this capture back from the phone")) }
                }
            }
        }
        return allSent
    }

    private enum class Outcome { SENT, LATER, SIGNED_OUT }

    private suspend fun send(start: QueuedItem): Outcome {
        var item = start
        if (item.mime != null && item.objectPath == null) {
            val owner = ownerId() ?: return Outcome.SIGNED_OUT
            item = queue.update(item.copy(objectPath = "$owner/${item.id}.${ShelfTypes.extension(item.mime)}",
                voicePath = item.voiceMime?.let { "$owner/${item.id}-voice.${ShelfTypes.extension(it)}" }))
        }
        while (true) {
            val step = when (item.stage) {
                QueuedItem.ADD -> api.add(item)
                // The photo, then what was said about it. A retry finds a file already there and moves on.
                QueuedItem.UPLOAD -> api.upload(item.objectPath, item.mime, queue.file(item)).let { first ->
                    if (first !is Step.Done || item.voicePath == null) first else api.upload(item.voicePath, item.voiceMime, queue.voice(item))
                }
                else -> api.describe(item)
            }
            when (step) {
                is Step.Done -> {
                    if (item.stage >= QueuedItem.READ) { queue.remove(item); return Outcome.SENT }
                    val next = if (item.stage == QueuedItem.ADD && item.objectPath == null) QueuedItem.READ else item.stage + 1
                    item = queue.update(item.copy(stage = next))
                }
                is Step.Never -> { queue.update(item.copy(problem = step.why)); return Outcome.SENT }
                is Step.SignedOut -> return Outcome.SIGNED_OUT
                is Step.Later -> return Outcome.LATER
            }
        }
    }
}
