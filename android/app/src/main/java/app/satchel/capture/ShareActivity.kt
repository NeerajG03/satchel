package app.satchel.capture

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast

/** "Share to Satchel" from any app. No screen: it queues what was shared and says so. */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = app
        if (!app.auth.signedIn) {
            Toast.makeText(this, "Sign in to Satchel first, then share again.", Toast.LENGTH_LONG).show()
            startActivity(Intent(this, MainActivity::class.java))
            return finish()
        }
        val message = runCatching { take(intent) }.getOrElse { it.message ?: "Satchel could not take that." }
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
        sendSoon()
        finish()
    }

    private fun take(intent: Intent): String {
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        val uris = when (intent.action) {
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else -> listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java))
        }
        if (uris.isEmpty()) {
            if (text.isEmpty()) return "There was nothing to save."
            app.queue.addNote(text)
            return if (text.length > ShelfTypes.NOTE_LIMIT) "Saved the first 4,000 characters to your Shelf" else "Saved to your Shelf"
        }
        var saved = 0
        var refused = 0
        for (uri in uris.take(10)) {
            val type = contentResolver.getType(uri) ?: intent.type.orEmpty()
            when {
                type.startsWith("image/") && type != "image/gif" -> {
                    app.queue.addFile("photo", "image/jpeg", Photos.shrink(this, uri), text); saved++
                }
                type.startsWith("audio/") && ShelfTypes.takes(type) -> {
                    val bytes = contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                    if (bytes.size > ShelfTypes.BYTE_LIMIT) refused++ else { app.queue.addFile("voice", type, bytes, text); saved++ }
                }
                else -> refused++
            }
        }
        return when {
            saved == 0 -> "The Shelf takes photos, voice notes and text, not this yet."
            refused > 0 -> "Saved $saved to your Shelf. $refused could not be taken."
            saved == 1 -> "Saved to your Shelf"
            else -> "Saved $saved to your Shelf"
        }
    }
}
