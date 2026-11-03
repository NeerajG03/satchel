package app.satchel.capture

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * "Share to Satchel" from any app. No screen: it queues what was shared and says so.
 * The work runs off the main thread while this stays open, because permission
 * to read a shared file ends when the activity finishes.
 */
class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!app.auth.signedIn) {
            Toast.makeText(this, "Sign in to Satchel first, then share again.", Toast.LENGTH_LONG).show()
            startActivity(Intent(this, MainActivity::class.java))
            return finish()
        }
        if (savedInstanceState != null) return finish()
        lifecycleScope.launch {
            val message = withContext(Dispatchers.IO) { take(intent) }
            Toast.makeText(this@ShareActivity, message, Toast.LENGTH_SHORT).show()
            sendSoon()
            finish()
        }
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
            val kept = runCatching {
                when {
                    type.startsWith("image/") && type != "image/gif" ->
                        app.queue.addFile("photo", "image/jpeg", Photos.shrink(this, uri), text)
                    type.startsWith("audio/") && ShelfTypes.takes(type) && size(uri) in 1..ShelfTypes.BYTE_LIMIT.toLong() ->
                        app.queue.addFile("voice", type, contentResolver.openInputStream(uri)!!.use { it.readBytes() }, text)
                    else -> null
                }
            }.getOrNull()
            if (kept != null) saved++ else refused++
        }
        return when {
            saved == 0 -> "The Shelf takes photos, voice notes up to 20 MB and text, not this."
            refused > 0 -> "Saved $saved to your Shelf. $refused could not be taken."
            saved == 1 -> "Saved to your Shelf"
            else -> "Saved $saved to your Shelf"
        }
    }

    /** The size the sharing app reports, read before the file is: a large one is refused without loading it. */
    private fun size(uri: Uri): Long = contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)
        ?.use { if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else -1L } ?: -1L
}
