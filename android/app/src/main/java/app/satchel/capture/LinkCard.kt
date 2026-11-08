package app.satchel.capture

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private val LINK = Regex("""\bhttps?://[^\s<>"']+[^\s<>"'.,;:!?)\]]""", RegexOption.IGNORE_CASE)

/** The words of a note with its links taken out, and the links on their own. */
fun splitLinks(note: String): Pair<String, List<String>> {
    val links = LINK.findAll(note).map { it.value }.distinct().take(3).toList()
    val words = note.replace(LINK, " ").replace(Regex("[ \\t]+"), " ").replace(Regex("\\s*\\n\\s*"), "\n").trim()
    return words to links
}

fun domainOf(url: String): String = runCatching { Uri.parse(url).host?.removePrefix("www.") }.getOrNull() ?: url

/** Previews and pictures already read, so scrolling back does not read them again. */
private object Previews {
    val pages = android.util.LruCache<String, Result<LinkPreview?>>(60)
    val pictures = android.util.LruCache<String, ImageBitmap>(30)
}

/** A link as a person recognises it: the page's picture and title, and only the site's name. */
@Composable
fun LinkCard(url: String, reader: ShelfReader) {
    val context = LocalContext.current
    var preview by remember(url) { mutableStateOf(Previews.pages.get(url)?.getOrNull()) }
    var picture by remember(url) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(url) {
        if (Previews.pages.get(url) == null) {
            val read = runCatching { reader.preview(url) }
            // A failed read is tried again next time; a page with nothing to show is remembered.
            if (read.isSuccess) Previews.pages.put(url, read)
            preview = read.getOrNull()
        }
        val image = preview?.image ?: return@LaunchedEffect
        picture = Previews.pictures.get(image) ?: runCatching {
            val bytes = reader.bytes(image)
            withContext(Dispatchers.Default) {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (bounds.outWidth / (sample * 2) >= 720) sample *= 2
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
            }
        }.getOrNull()?.also { Previews.pictures.put(image, it) }
    }
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, Line, shape).background(Paper2)
        .clickable(role = Role.Button, onClickLabel = "Open ${domainOf(url)}") {
            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }) {
        picture?.let { Image(it, null, Modifier.fillMaxWidth().heightIn(max = 180.dp), contentScale = ContentScale.Crop) }
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            preview?.title?.let { Text(it, style = Type.words, color = InkText, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            Text("${domainOf(url)} ↗", style = Type.readout, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
