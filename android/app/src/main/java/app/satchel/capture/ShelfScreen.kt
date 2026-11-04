package app.satchel.capture

import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.MediaPlayer
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter

private val PROFILE = mapOf("work" to "Work", "personal" to "Personal")
private val SHORT_DAY = DateTimeFormatter.ofPattern("EEE d MMM")
private val DAY_TIME = DateTimeFormatter.ofPattern("EEE d, HH:mm")

/** Thumbnails already fetched, by file path, so scrolling back does not fetch them again. */
private object Thumbs {
    private val cache = android.util.LruCache<String, ImageBitmap>(40)
    fun get(path: String): ImageBitmap? = cache.get(path)
    fun put(path: String, picture: ImageBitmap) { cache.put(path, picture) }
}

/**
 * The Shelf on the phone: what is waiting for a yes, the week ahead, and
 * everything dropped, by topic. The big key opens capture.
 */
@Composable
fun ShelfScreen(reader: ShelfReader, unsent: Int, stuck: List<QueuedItem>, onClearStuck: () -> Unit,
                onCapture: (String) -> Unit, onSignOut: () -> Unit) {
    val scope = rememberCoroutineScope()
    var items by remember { mutableStateOf<List<ShelfEntry>?>(null) }
    var waiting by remember { mutableStateOf(listOf<Waiting>()) }
    var week by remember { mutableStateOf<Week?>(null) }
    var links by remember { mutableStateOf(mapOf<String, String>()) }
    var problem by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var profile by rememberSaveableProfile()
    var query by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<List<ShelfEntry>?>(null) }
    var said by remember { mutableStateOf<String?>(null) }
    var openId by remember { mutableStateOf<String?>(null) }
    var lines by remember { mutableStateOf(listOf<ListLine>()) }
    var asDropped by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(false) }
    var lookedBack by remember { mutableStateOf(false) }
    val player = remember { Player() }
    DisposableEffect(Unit) { onDispose { player.stop() } }

    fun load() {
        loading = true
        scope.launch {
            problem = null
            val list = async { runCatching { reader.items() } }
            val wait = async { runCatching { reader.waiting() } }
            val ahead = async { runCatching { reader.week() } }
            val listed = async { runCatching { reader.lines() } }
            list.await().onSuccess { items = it }.onFailure { problem = it.message }
            wait.await().onSuccess { waiting = it }
            ahead.await().onSuccess { week = it }
            listed.await().onSuccess { lines = it }
            val paths = (items ?: emptyList()).flatMap { listOfNotNull(it.objectPath, it.voicePath) }.filter { it !in links }
            runCatching { reader.links(paths) }.onSuccess { links = links + it }
            loading = false
            // Drops from before lists are looked at once, a few per visit, quietly.
            if (!lookedBack) {
                lookedBack = true
                if (runCatching { reader.listOldDrops() }.getOrDefault(0) > 0) runCatching { reader.lines() }.onSuccess { lines = it }
            }
        }
    }
    LaunchedEffect(Unit) { load() }

    fun search() {
        val q = query.trim()
        if (q.isEmpty()) { found = null; return }
        scope.launch { runCatching { reader.search(q) }.onSuccess { found = it; problem = null }.onFailure { problem = it.message } }
    }

    val inProfile = { p: String? -> profile == "all" || p == null || p == profile }
    val shown = found ?: (items ?: emptyList()).filter { inProfile(it.profile) }
    val lined = lines.flatMap { it.itemIds }.toSet()
    val sections = shown.filter { asDropped || it.id !in lined }.groupBy { if (asDropped) "As dropped" else it.topicName ?: "" }.entries
        .sortedWith(compareBy<Map.Entry<String, List<ShelfEntry>>> { it.key.isEmpty() }.thenByDescending { it.value.size })

    Box(Modifier.fillMaxSize().background(Paper)) {
        PullToRefreshBox(isRefreshing = loading, onRefresh = ::load, modifier = Modifier.fillMaxSize()) {
            LazyColumn(
                Modifier.fillMaxSize().statusBarsPadding(),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 140.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("satchel", fontFamily = FontFamily.Cursive, fontSize = 32.sp, color = InkText)
                        Spacer(Modifier.weight(1f))
                        for (p in listOf("all", "work", "personal")) {
                            val on = profile == p
                            Text(PROFILE[p] ?: "All", color = if (on) Paper else InkText, fontSize = 14.sp,
                                modifier = Modifier.padding(start = 4.dp).clip(RoundedCornerShape(8.dp))
                                    .background(if (on) Ink else Paper2).clickable { profile = p }
                                    .padding(horizontal = 12.dp, vertical = 10.dp))
                        }
                    }
                }
                item {
                    OutlinedTextField(query, { query = it; if (it.isBlank()) found = null }, Modifier.fillMaxWidth(),
                        placeholder = { Text("Find something, the way you remember it") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        keyboardActions = KeyboardActions(onSearch = { search() }),
                        trailingIcon = { if (found != null) TextButton({ query = ""; found = null }) { Text("Clear", color = Muted) } })
                }
                problem?.let { item { Text(it, color = Red, fontSize = 14.sp) } }
                said?.let { item { Text(it, color = Green, fontSize = 14.sp) } }
                if (unsent > 0 || stuck.isNotEmpty()) item { Outbox(unsent, stuck, onClearStuck) }

                val wait = waiting.filter { inProfile(it.profile) }
                if (found == null && wait.isNotEmpty()) item {
                    Card("Waiting for you", "Found in what you dropped. Nothing is added until you say so.") {
                        wait.forEach { w ->
                            WaitingRow(w, linked = week?.linked ?: emptyList(), onAdd = { where ->
                                scope.launch {
                                    runCatching { reader.addToGoogle(w.id, where) }
                                        .onSuccess { kind -> waiting = waiting - w; said = if (kind == "task") "Added to ${PROFILE[where]} Google Tasks" else "Added to ${PROFILE[where]} Google Calendar" }
                                        .onFailure { problem = it.message }
                                }
                            }, onDismiss = {
                                scope.launch { runCatching { reader.dismiss(w.id) }.onSuccess { waiting = waiting - w }.onFailure { problem = it.message } }
                            })
                        }
                    }
                }
                val coming = week?.items?.filter { profile == "all" || it.profile == profile } ?: emptyList()
                if (found == null && coming.isNotEmpty()) item {
                    Card("Coming up", "Next 7 days, from Google") {
                        coming.take(6).forEach { c ->
                            Row(Modifier.padding(vertical = 6.dp)) {
                                Text(whenOf(c), color = Muted, fontSize = 13.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.width(104.dp))
                                Text((if (c.kind == "task") "Task · " else "") + c.title, color = InkText, fontSize = 15.sp, modifier = Modifier.weight(1f))
                            }
                        }
                        if (coming.size > 6) Text("and ${coming.size - 6} more", color = Muted, fontSize = 13.sp)
                    }
                }

                val myLines = lines.filter { inProfile(it.profile) }
                if (found == null && !asDropped) {
                    val names = lines.groupBy { it.list }.entries.sortedByDescending { it.value.size }.map { it.key }
                    for (name in names) {
                        val here = myLines.filter { it.list == name }
                        if (here.isEmpty()) continue
                        item(key = "list-$name") {
                            ListCard(name, here, names, items ?: emptyList(), onRun = { act ->
                                scope.launch {
                                    runCatching { act() }.onSuccess { said = it; problem = null; runCatching { reader.lines() }.onSuccess { l -> lines = l } }
                                        .onFailure { problem = it.message }
                                }
                            }, reader = reader)
                        }
                    }
                }
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Spacer(Modifier.weight(1f))
                        TextButton({ asDropped = !asDropped }) { Text(if (asDropped) "Rearranged" else "As dropped", color = Muted) }
                    }
                }
                if (found != null) item { Text(if (shown.isEmpty()) "Nothing on your Shelf fits that." else "${shown.size} closest first",
                    color = Muted, fontSize = 13.sp) }
                if (items != null && items!!.isEmpty()) item {
                    Text("Your Shelf is empty. Press Drop to put a photo, a voice note or a note on it.", color = Muted)
                }
                for ((name, entries) in if (found != null) listOf(mapOf("" to shown).entries.first()) else sections) {
                    if (found == null) item(key = "h-$name") {
                        Text(name.ifEmpty { "Not in a topic yet" }, fontFamily = FontFamily.Serif, fontSize = 22.sp, color = InkText,
                            modifier = Modifier.padding(top = 8.dp))
                    }
                    items(entries, key = { it.id }) { e ->
                        EntryCard(e, links, reader, player, showProfile = profile == "all", open = openId == e.id,
                            added = lines.filter { e.id in it.itemIds }.groupingBy { it.list }.eachCount(),
                            onOpen = { openId = if (openId == e.id) null else e.id }) { act, done ->
                            scope.launch {
                                runCatching { act() }
                                    .onSuccess { message -> said = message; problem = null; done(); load() }
                                    .onFailure { problem = it.message; done() }
                            }
                        }
                    }
                }
                item {
                    Column(Modifier.padding(top = 24.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("Quickest way in: Settings › System › Quick Tap › Open app › Satchel Capture. Then double-tap the back of the phone, even when it is locked.",
                            color = Muted, fontSize = 13.sp)
                        TextButton(onSignOut) { Text(if (unsent > 0) "Sign out (removes $unsent not yet sent)" else "Sign out", color = Muted) }
                    }
                }
            }
        }

        // A solid bar, so the keys never sit on top of an item scrolling under them.
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Paper)) {
          HorizontalDivider(color = Line)
          Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Button({ onCapture("note") }, Modifier.height(56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Paper2, contentColor = InkText)) { Text("Note", fontSize = 16.sp) }
            Button({ onCapture("camera") }, Modifier.height(56.dp).weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = Ink, contentColor = Paper)) {
                Text("Drop", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            }
          }
        }
    }
}

@Composable
private fun rememberSaveableProfile() = androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf("all") }

@Composable
private fun Card(title: String, sub: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(color = Paper2, shape = RoundedCornerShape(14.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, fontFamily = FontFamily.Serif, fontSize = 20.sp, color = InkText)
            Text(sub, color = Muted, fontSize = 13.sp)
            Spacer(Modifier.height(4.dp))
            content()
        }
    }
}

@Composable
private fun WaitingRow(w: Waiting, linked: List<String>, onAdd: (String) -> Unit, onDismiss: () -> Unit) {
    var busy by remember(w.id) { mutableStateOf(false) }
    Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        HorizontalDivider(color = Line)
        Text(listOfNotNull(if (w.kind == "todo") "TO-DO" else "EVENT", w.profile?.let { PROFILE[it]?.uppercase() }, w.when_?.let(::dayOf))
            .joinToString(" · "), color = Muted, fontSize = 11.sp, letterSpacing = 1.sp)
        Text(w.title, color = InkText, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            val targets = w.profile?.let { listOf(it) } ?: listOf("work", "personal")
            for (where in targets) {
                if (where in linked) OutlinedButton({ busy = true; onAdd(where) }, enabled = !busy) {
                    Text(when {
                        w.profile == null -> "Add to ${PROFILE[where]}"
                        w.kind == "todo" -> "Add to Tasks"
                        else -> "Add to Calendar"
                    }, color = InkText)
                } else Text("Link ${PROFILE[where]} Google on the web first", color = Muted, fontSize = 13.sp)
            }
            TextButton(onDismiss, enabled = !busy) { Text("Dismiss", color = Muted) }
        }
    }
}

@Composable
private fun Outbox(unsent: Int, stuck: List<QueuedItem>, onClear: () -> Unit) {
    Surface(color = Paper2, shape = RoundedCornerShape(12.dp)) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (unsent > 0) Text("$unsent waiting to send. They go as soon as there is a connection.", color = InkText, fontSize = 14.sp)
            stuck.forEach { Text("· ${it.kind}: ${it.problem}", color = Red, fontSize = 13.sp) }
            if (stuck.isNotEmpty()) TextButton(onClear) { Text("Clear these") }
        }
    }
}

@Composable
private fun EntryCard(e: ShelfEntry, links: Map<String, String>, reader: ShelfReader, player: Player, showProfile: Boolean,
                      open: Boolean, added: Map<String, Int>, onOpen: () -> Unit, run: (suspend () -> String, () -> Unit) -> Unit) {
    var editing by remember(e.id) { mutableStateOf(false) }
    var removing by remember(e.id) { mutableStateOf(false) }
    Surface(color = Paper, shape = RoundedCornerShape(12.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, if (open) Muted else Line), modifier = Modifier.clickable(onClick = onOpen)) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (e.kind == "photo") Thumbnail(e.objectPath, links, reader, e.description ?: "A photo on your Shelf")
            val voice = if (e.kind == "voice") e.objectPath else e.voicePath
            voice?.let { path -> links[path]?.let { url -> PlayKey(url, player, if (e.kind == "photo") "Hear what you said" else "Play") } }
            if (e.note.isNotBlank()) Text(e.note, fontFamily = FontFamily.Serif, fontSize = 18.sp, color = InkText)
            e.transcript?.let { Text("“$it”", fontFamily = FontFamily.Serif, fontSize = 16.sp, color = InkText) }
            if (e.transcript == null || e.kind == "photo") e.description?.let { Text(it, color = Muted, fontSize = 14.sp, maxLines = 4) }
            Text(listOfNotNull(
                when (e.kind) { "photo" -> if (e.voicePath != null) "PHOTO + VOICE" else "PHOTO"; "voice" -> "VOICE NOTE"; else -> "NOTE" },
                if (showProfile) e.profile?.let { PROFILE[it]?.uppercase() } else null,
                dayOf(e.createdAt),
                when (e.status) { "ready" -> null; "failed" -> "COULD NOT READ"; else -> "READING…" },
            ).joinToString(" · "), color = Muted, fontSize = 11.sp, letterSpacing = 1.sp, fontFamily = FontFamily.Monospace)
            if (added.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Added to " + added.entries.joinToString(", ") { "${it.key} (${it.value})" }, color = InkText, fontSize = 13.sp,
                    modifier = Modifier.weight(1f))
                TextButton({ run({ reader.undoLines(e.id); "Taken off your lists" }) {} }) { Text("Undo", color = Muted) }
            }
            if (open) ItemActions(e, onEdit = { editing = true }, onRemove = { removing = true }, run = run, reader = reader)
        }
    }
    if (editing) EditNote(e, onCancel = { editing = false }) { text -> run({ reader.edit(e.id, text); "Note changed" }) { editing = false } }
    if (removing) AlertDialog(
        onDismissRequest = { removing = false },
        title = { Text("Remove this from your Shelf?") },
        text = { Text("It goes for good, with its file. Nothing can bring it back.") },
        confirmButton = { TextButton({ run({ reader.remove(e.id); "Removed from your Shelf" }) { removing = false } }) { Text("Remove for good", color = Red) } },
        dismissButton = { TextButton({ removing = false }) { Text("Keep it", color = InkText) } },
    )
}

/** What can be done to one item: change its note or profile, find its to-dos, read it again, or remove it. */
@Composable
private fun ItemActions(e: ShelfEntry, onEdit: () -> Unit, onRemove: () -> Unit, run: (suspend () -> String, () -> Unit) -> Unit,
                        reader: ShelfReader) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        HorizontalDivider(color = Line)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Profile", color = Muted, fontSize = 13.sp)
            for ((key, label) in listOf("work" to "Work", "personal" to "Personal", null to "None")) {
                val on = e.profile == key
                Text(label, color = if (on) Paper else InkText, fontSize = 13.sp,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(if (on) Ink else Paper2)
                        .clickable(enabled = !on) { run({ reader.setProfile(e.id, key); if (key == null) "Taken out of both profiles" else "Moved to $label" }) {} }
                        .padding(horizontal = 12.dp, vertical = 10.dp))
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (e.status == "ready" || e.status == "failed") TextButton(onEdit) { Text(if (e.note.isBlank()) "Add a note" else "Edit note", color = InkText) }
            if (e.status == "ready" && e.sortedAt == null) TextButton({
                run({ reader.sort(e.id).let { n -> if (n == 0) "Nothing to do in this one" else "Found $n to do" } }) {}
            }) { Text("Look for to-dos", color = InkText) }
            if (e.status == "failed") TextButton({ run({ reader.reread(e.id); "Reading it again" }) {} }) { Text("Read again", color = InkText) }
            Spacer(Modifier.weight(1f))
            TextButton(onRemove) { Text("Remove", color = Red) }
        }
    }
}

@Composable
private fun EditNote(e: ShelfEntry, onCancel: () -> Unit, onSave: (String) -> Unit) {
    var text by remember(e.id) { mutableStateOf(e.note) }
    var saving by remember(e.id) { mutableStateOf(false) }
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    AlertDialog(
        onDismissRequest = { if (!saving) onCancel() },
        title = { Text(if (e.note.isBlank()) "Add a note" else "Edit note") },
        text = {
            OutlinedTextField(text, { text = it.take(ShelfTypes.NOTE_LIMIT) }, minLines = 3, maxLines = 8,
                modifier = Modifier.fillMaxWidth().focusRequester(focus))
            LaunchedEffect(Unit) { focus.requestFocus() }
        },
        confirmButton = {
            TextButton({ saving = true; onSave(text.trim()) }, enabled = !saving && (e.kind != "note" || text.isNotBlank())) {
                Text(if (saving) "Saving…" else "Save", color = InkText)
            }
        },
        dismissButton = { TextButton(onCancel, enabled = !saving) { Text("Cancel", color = Muted) } },
    )
}

@Composable
private fun Thumbnail(path: String?, links: Map<String, String>, reader: ShelfReader, label: String) {
    val url = path?.let { links[it] }
    var picture by remember(path) { mutableStateOf(path?.let(Thumbs::get)) }
    LaunchedEffect(url) {
        if (picture != null || url == null || path == null) return@LaunchedEffect
        picture = runCatching {
            val bytes = reader.bytes(url)
            withContext(Dispatchers.Default) {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (bounds.outWidth / (sample * 2) >= 720) sample *= 2
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                    ?.asImageBitmap()
            }
        }.getOrNull()?.also { Thumbs.put(path, it) }
    }
    val shape = RoundedCornerShape(10.dp)
    picture?.let { Image(it, label, Modifier.fillMaxWidth().heightIn(max = 260.dp).clip(shape), contentScale = ContentScale.Crop) }
        ?: Box(Modifier.fillMaxWidth().height(160.dp).clip(shape).background(Paper2))
}

/** One voice note plays at a time; starting another stops the first. */
private class Player {
    var playing by mutableStateOf<String?>(null)
        private set
    private var media: MediaPlayer? = null
    fun toggle(url: String) {
        val again = playing == url
        stop()
        if (again) return
        media = MediaPlayer().apply {
            setAudioAttributes(AudioAttributes.Builder().setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            setDataSource(url)
            setOnPreparedListener { it.start() }
            setOnCompletionListener { stop() }
            setOnErrorListener { _, _, _ -> stop(); true }
            prepareAsync()
        }
        playing = url
    }
    fun stop() { media?.release(); media = null; playing = null }
}

@Composable
private fun PlayKey(url: String, player: Player, label: String) {
    val on = player.playing == url
    Row(Modifier.clip(RoundedCornerShape(24.dp)).background(Ink).clickable { player.toggle(url) }.padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(10.dp).background(if (on) Red else Orange, CircleShape))
        Text(if (on) "Stop" else label, color = Paper, fontSize = 14.sp)
    }
}

private fun whenOf(c: Coming): String = runCatching {
    c.at?.let { OffsetDateTime.parse(it).atZoneSameInstant(java.time.ZoneId.systemDefault()).format(DAY_TIME) }
        ?: c.day?.let { LocalDate.parse(it).format(SHORT_DAY) } ?: ""
}.getOrDefault("")

private fun dayOf(value: String): String? = runCatching {
    if (value.length == 10) LocalDate.parse(value).format(SHORT_DAY).uppercase()
    else OffsetDateTime.parse(value).atZoneSameInstant(java.time.ZoneId.systemDefault()).format(SHORT_DAY).uppercase()
}.getOrNull()

/** One list the Shelf made: lines to go, a tick each, and a fold of the ones done. */
@Composable
private fun ListCard(name: String, lines: List<ListLine>, names: List<String>, items: List<ShelfEntry>,
                     onRun: (suspend () -> String) -> Unit, reader: ShelfReader) {
    val open = lines.filter { it.status == "want" }
    val done = lines.filter { it.status == "done" }
    var showDone by remember(name) { mutableStateOf(false) }
    var openLine by remember(name) { mutableStateOf<String?>(null) }
    val kind = lines.firstOrNull()?.kind ?: "item"
    val doneWord = if (kind == "expense") "claimed" else "done"
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    Card(name, if (kind == "fact") "Tap Copy to use one" else
        "${open.size} ${if (kind == "expense") "to claim" else "to go"}${if (done.isNotEmpty()) " · ${done.size} $doneWord" else ""}") {
        (open + if (showDone) done else emptyList()).forEach { line ->
            Column {
                Row(Modifier.fillMaxWidth().clickable { openLine = if (openLine == line.id) null else line.id }
                    .padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (kind == "fact") IconButton({
                        clipboard.setText(androidx.compose.ui.text.AnnotatedString(line.detail ?: ""))
                        onRun { "Copied ${line.title}" }
                    }) { Icon(painterResource(R.drawable.ic_copy), "Copy ${line.title}", tint = Muted, modifier = Modifier.size(20.dp)) }
                    else Checkbox(line.status == "done", { on -> onRun { reader.tick(line.id, on); if (on) "${doneWord.replaceFirstChar { it.uppercase() }}: ${line.title}" else "Back on $name" } },
                        colors = CheckboxDefaults.colors(checkedColor = Ink))
                    Column(Modifier.weight(1f)) {
                        if (kind == "fact") Text(line.title.uppercase(), color = Muted, fontSize = 11.sp, letterSpacing = 1.sp)
                        Text(if (kind == "fact") line.detail ?: "" else line.title,
                            fontFamily = if (kind == "fact") FontFamily.Monospace else FontFamily.Serif, fontSize = 17.sp,
                            color = if (line.status == "done") Muted else InkText,
                            textDecoration = if (line.status == "done") androidx.compose.ui.text.style.TextDecoration.LineThrough else null)
                        if (kind == "expense") Text(listOfNotNull(moneyOf(line), line.spentOn?.let(::dayOf), if (line.profile == "work") "WORK" else null)
                            .joinToString(" · "), color = Muted, fontSize = 13.sp)
                        else if (kind == "item") line.detail?.let { Text(it, color = Muted, fontSize = 13.sp) }
                    }
                }
                if (openLine == line.id) Column(Modifier.padding(start = 48.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    line.itemIds.mapNotNull { id -> items.find { it.id == id } }.forEach { e ->
                        Text("from “" + (listOf(e.note, e.transcript, e.description).firstOrNull { !it.isNullOrBlank() } ?: "a drop").take(120) + "”",
                            color = Muted, fontSize = 13.sp)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (kind == "item") names.filter { it != name && it.lowercase() !in setOf("expenses", "good to know") }.take(3).forEach { other ->
                            Text("→ $other", color = InkText, fontSize = 13.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp))
                                .background(Paper).clickable { onRun { reader.moveLine(line.id, other); "Moved to $other" } }
                                .padding(horizontal = 10.dp, vertical = 8.dp))
                        }
                        Spacer(Modifier.weight(1f))
                        TextButton({ onRun { reader.removeLine(line.id); "Removed ${line.title}" } }) { Text("Remove", color = Red) }
                    }
                }
            }
        }
        if (done.isNotEmpty()) TextButton({ showDone = !showDone }) { Text(if (showDone) "Hide done" else "Show done (${done.size})", color = Muted) }
    }
}

/** An amount as printed: ₹2,340.00, $23.40, or the bare number when no currency was shown. */
private fun moneyOf(line: ListLine): String {
    val n = line.amount?.toBigDecimalOrNull() ?: return "amount?"
    return runCatching {
        java.text.NumberFormat.getCurrencyInstance().apply { currency = java.util.Currency.getInstance(line.currency!!) }.format(n)
    }.getOrElse { java.text.DecimalFormat("#,##0.00").format(n) }
}
