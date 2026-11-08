package app.satchel.capture

import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.MediaPlayer
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
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
 * The Shelf on the phone, in Satchel's own look: a hardware frame (the
 * wordmark, a status light with its word, the profile keys, and a dock with
 * the Drop key under the thumb) around a paper sheet that holds the person's
 * things. The sheet shows the numbers first, the lists as tiles that open
 * their own page, what waits for a yes, the week, and the latest drops.
 */
@Composable
fun ShelfScreen(reader: ShelfReader, unsent: Int, stuck: List<QueuedItem>, onClearStuck: () -> Unit,
                onCapture: (String) -> Unit, onSignOut: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    var items by remember { mutableStateOf<List<ShelfEntry>?>(null) }
    var waiting by remember { mutableStateOf(listOf<Waiting>()) }
    var week by remember { mutableStateOf<Week?>(null) }
    var links by remember { mutableStateOf(mapOf<String, String>()) }
    var problem by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var profile by rememberSaveableProfile()
    var query by remember { mutableStateOf("") }
    var lastSearch by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf<String?>(null) }
    var found by remember { mutableStateOf<List<ShelfEntry>?>(null) }
    var said by remember { mutableStateOf<String?>(null) }
    var lines by remember { mutableStateOf(listOf<ListLine>()) }
    var asDropped by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(false) }
    var openList by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf<String?>(null) }
    var lookedBack by remember { mutableStateOf(false) }
    val player = remember { Player() }
    DisposableEffect(Unit) { onDispose { player.stop() } }
    androidx.activity.compose.BackHandler(enabled = openList != null || found != null) {
        if (openList != null) openList = null else { found = null; query = "" }
    }

    fun load() {
        loading = true
        scope.launch {
            problem = null
            val list = async { runCatching { reader.items() } }
            val wait = async { runCatching { reader.waiting() } }
            val ahead = async { runCatching { reader.week() } }
            val listed = async { runCatching { reader.lines() } }
            list.await().onSuccess { items = it }.onFailure { problem = it.message }
            // A note a connected app dropped waits for someone to ask for its read; the phone asks, as the web does.
            val fromApps = (items ?: emptyList()).filter { it.addedBy != null && it.status == "waiting" }
            if (fromApps.isNotEmpty()) {
                fromApps.forEach { runCatching { reader.reread(it.id) } }
                runCatching { reader.items() }.onSuccess { items = it }
            }
            wait.await().onSuccess { waiting = it }
            ahead.await().onSuccess { week = it }
            listed.await().onSuccess { lines = it }
            val paths = (items ?: emptyList()).flatMap { listOfNotNull(it.objectPath, it.voicePath) }.filter { it !in links }
            runCatching { reader.links(paths) }.onSuccess { links = links + it }
            loading = false
            WaitingWidget.refresh(context)
            // Drops from before lists are looked at once, a few per visit, quietly.
            if (!lookedBack) {
                lookedBack = true
                if (runCatching { reader.listOldDrops() }.getOrDefault(0) > 0) runCatching { reader.lines() }.onSuccess { lines = it }
            }
        }
    }
    LaunchedEffect(Unit) { load() }

    fun search(q: String = query) {
        val text = q.trim()
        query = text
        if (text.isEmpty()) { found = null; return }
        scope.launch {
            runCatching { reader.search(text) }.onSuccess { found = it; problem = null; lastSearch = text }.onFailure { problem = it.message }
        }
    }
    val runLines: (suspend () -> String) -> Unit = { act ->
        scope.launch {
            runCatching { act() }.onSuccess { said = it; problem = null; runCatching { reader.lines() }.onSuccess { l -> lines = l } }
                .onFailure { problem = it.message }
        }
    }

    val inProfile = { p: String? -> profile == "all" || p == null || p == profile }
    val shown = found ?: (items ?: emptyList()).filter { inProfile(it.profile) }
    val lined = lines.flatMap { it.itemIds }.toSet()
    val loose = shown.filter { asDropped || it.id !in lined }
    val myLines = lines.filter { inProfile(it.profile) }
    val names = lines.groupBy { it.list }.entries.sortedByDescending { it.value.size }.map { it.key }
    val wait = waiting.filter { inProfile(it.profile) }
    val coming = week?.items?.filter { profile == "all" || it.profile == profile } ?: emptyList()
    val claim = myLines.filter { it.kind == "expense" && it.status == "want" }
        .mapNotNull { l -> l.amount?.toBigDecimalOrNull()?.let { (l.currency ?: "") to it } }
        .groupBy({ it.first }, { it.second }).mapValues { (_, v) -> v.fold(java.math.BigDecimal.ZERO, java.math.BigDecimal::add) }

    Column(Modifier.fillMaxSize().background(Hw)) {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text("satchel", fontFamily = Mark, fontSize = 32.sp, color = HwText, modifier = Modifier.weight(1f))
            when {
                stuck.isNotEmpty() -> Led(LedRed, "${stuck.size} stuck")
                unsent > 0 -> Led(LedAmber, "$unsent sending")
                problem != null -> Led(LedOff, "offline")
                else -> Led(LedGreen, "synced")
            }
        }
        if (openList == null) Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (p in listOf("all", "work", "personal"))
                HardwareKey(PROFILE[p] ?: "All", { profile = p }, Modifier.weight(1f), selected = profile == p)
        } else Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            HardwareKey("‹", { openList = null }, description = "Back to the Shelf")
            Text("SHELF · LIST", style = Type.readout, color = HwMuted)
        }

        Box(Modifier.weight(1f).padding(horizontal = 8.dp).clip(RoundedCornerShape(14.dp)).background(Paper)) {
            val listName = openList
            if (listName != null) {
                ListPage(listName, lines.filter { it.list == listName }, names, items ?: emptyList(), reader, runLines)
                return@Box
            }
            PullToRefreshBox(isRefreshing = loading, onRefresh = ::load, modifier = Modifier.fillMaxSize()) {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                    item {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            OutlinedTextField(query, { query = it; if (it.isBlank()) found = null }, Modifier.fillMaxWidth(),
                                placeholder = { Text("Find it the way you remember it", style = Type.body, color = Muted) },
                                textStyle = Type.body, singleLine = true, shape = RoundedCornerShape(8.dp),
                                colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = Paper2, focusedContainerColor = Paper2,
                                    unfocusedBorderColor = Line, focusedBorderColor = Accent, cursorColor = InkText),
                                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                                keyboardActions = KeyboardActions(onSearch = { search() }),
                                trailingIcon = { if (found != null) TextButton({ query = ""; found = null }) { Text("Clear", style = Type.fine, color = Muted) } })
                            // Never a blank search: the lists there are, and the last thing looked for.
                            if (found == null) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                lastSearch?.let { last -> Chip("“$last”", { search(last) }, quiet = true) }
                                names.take(4).forEach { n -> Chip(n, { openList = n }) }
                            }
                        }
                    }
                    problem?.let { item { Text(it, style = Type.fine, color = Red) } }
                    said?.let { item { Text(it, style = Type.fine, color = Green) } }
                    if (stuck.isNotEmpty()) item { Outbox(stuck, onClearStuck) }

                    if (found != null) {
                        item { Text(if (shown.isEmpty()) "Nothing on your Shelf fits that." else "${shown.size} closest first", style = Type.fine, color = Muted) }
                    } else {
                        // The numbers first, in figures, with their word under them.
                        item {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Figure(wait.size.toString(), if (wait.size == 1) "waiting for you" else "waiting for you", Modifier.weight(1f))
                                // The next thing with a time still ahead: an all-day or already-started one is not "next".
                                coming.firstOrNull { c -> c.kind == "event" && startsLater(c) }?.let { c -> Figure(timeOf(c), c.title, Modifier.weight(1f)) }
                                    ?: Figure(lines.count { it.status == "want" }.toString(), "on your lists", Modifier.weight(1f))
                                if (claim.isNotEmpty()) Figure(claim.entries.joinToString(" + ") { short(it.value, it.key.ifEmpty { null }) }, "to claim", Modifier.weight(1f))
                                else Figure((items?.size ?: 0).toString(), "on your Shelf", Modifier.weight(1f))
                            }
                        }
                        if (wait.isNotEmpty()) item {
                            Section("Waiting for you") {
                                wait.forEach { w ->
                                    WaitingRow(w, linked = week?.linked ?: emptyList(), onAdd = { where ->
                                        scope.launch {
                                            runCatching { reader.addToGoogle(w.id, where) }
                                                .onSuccess { place -> waiting = waiting - w; WaitingWidget.refresh(context)
                                                    said = "Added to ${PROFILE[where]} $place" }
                                                .onFailure { problem = it.message }
                                        }
                                    }, onDismiss = {
                                        scope.launch { runCatching { reader.dismiss(w.id) }.onSuccess { waiting = waiting - w; WaitingWidget.refresh(context) }
                                            .onFailure { problem = it.message } }
                                    })
                                }
                            }
                        }
                        if (names.isNotEmpty() && !asDropped) item {
                            Section("Your lists", names.size.toString()) {
                                names.chunked(2).forEach { pair ->
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        pair.forEach { n -> ListTile(n, myLines.filter { it.list == n }, Modifier.weight(1f)) { openList = n } }
                                        if (pair.size == 1) Spacer(Modifier.weight(1f))
                                    }
                                }
                            }
                        }
                        if (coming.isNotEmpty()) item { Section("Coming up", "7 DAYS") { Timeline(coming.take(5)) } }
                        item {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(if (asDropped) "Everything, as dropped" else "Recent drops", style = Type.block, color = InkText, modifier = Modifier.weight(1f))
                                TextButton({ asDropped = !asDropped }) { Text(if (asDropped) "Rearranged" else "As dropped", style = Type.fine, color = Accent) }
                            }
                        }
                        if (items != null && items!!.isEmpty()) item {
                            Text("Nothing here yet. Point at something and press Drop: a photo, what you say about it, or a note.", style = Type.body, color = Muted)
                        }
                    }
                    items((if (found != null) shown else loose), key = { it.id }) { e ->
                        EntryCard(e, links, reader, player, showProfile = profile == "all",
                            added = lines.filter { e.id in it.itemIds }.groupingBy { it.list }.eachCount()) { act, done ->
                            scope.launch {
                                runCatching { act() }
                                    .onSuccess { message -> said = message; problem = null; done(); load() }
                                    .onFailure { problem = it.message; done() }
                            }
                        }
                    }
                    item {
                        Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Quickest way in: Settings › System › Quick Tap › Open app › Satchel Capture. Then double-tap the back of the phone, even when it is locked.",
                                style = Type.fine, color = Muted)
                            TextButton(onSignOut, contentPadding = PaddingValues(0.dp)) {
                                Text(if (unsent > 0) "Sign out (removes $unsent not yet sent)" else "Sign out", style = Type.fine, color = Muted)
                            }
                        }
                    }
                }
            }
        }

        // The dock: hardware, under the thumb. Drop is the big key, with its light.
        Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HardwareKey("Note", { onCapture("note") }, height = 56.dp)
            HardwareKey("Drop", { onCapture("camera") }, Modifier.weight(1f), height = 56.dp, light = Orange,
                description = "Open capture: tap for a photo, hold to show it and say it")
        }
    }
}

@Composable
private fun rememberSaveableProfile() = androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf("all") }

/** A heading on paper and what sits under it, 12 apart; sections are 24 apart. */
@Composable
private fun Section(title: String, count: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(title, style = Type.block, color = InkText, modifier = Modifier.weight(1f))
            count?.let { Text(it, style = Type.readout, color = Muted) }
        }
        content()
    }
}

/** A value first, in figures, and its word under it: never the label bigger than the number. */
@Composable
private fun Figure(value: String, word: String, modifier: Modifier = Modifier) {
    Column(modifier.clip(RoundedCornerShape(12.dp)).background(Paper2).padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(value, style = Type.figure, color = InkText, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        Text(word, style = Type.fine, color = Muted, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
    }
}

/** A list as a tile: its name, how many are left (or owed), and the first few, tapping into its page. */
@Composable
private fun ListTile(name: String, lines: List<ListLine>, modifier: Modifier = Modifier, onOpen: () -> Unit) {
    val open = lines.filter { it.status == "want" }
    val kind = lines.firstOrNull()?.kind ?: "item"
    val owed = open.mapNotNull { l -> l.amount?.toBigDecimalOrNull()?.let { (l.currency ?: "") to it } }
        .groupBy({ it.first }, { it.second }).mapValues { (_, v) -> v.fold(java.math.BigDecimal.ZERO, java.math.BigDecimal::add) }
    Column(modifier.heightIn(min = 112.dp).clip(RoundedCornerShape(12.dp)).background(CardPaper).clickable(onClick = onOpen)
        .padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(name, style = Type.block, color = InkText, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        Text(when {
            kind == "expense" && owed.isNotEmpty() -> owed.entries.joinToString(" + ") { money(it.value, it.key.ifEmpty { null }) } + " TO CLAIM"
            kind == "fact" -> "${open.size} SAVED"
            else -> "${open.size} TO GO"
        }, style = Type.readout, color = Muted)
        Text(open.take(3).joinToString(", ") { if (kind == "fact") it.title else it.title }, style = Type.fine, color = Muted,
            maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
    }
}

/** The week as a short timeline: a mark per thing, the day once, then its times. */
@Composable
private fun Timeline(coming: List<Coming>) {
    var lastDay: String? = null
    Column {
        coming.forEach { c ->
            val day = dayLabel(c)
            if (day != lastDay) {
                Text(day.uppercase(), style = Type.readout, color = Muted, modifier = Modifier.padding(top = if (lastDay == null) 0.dp else 12.dp, bottom = 4.dp))
                lastDay = day
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.padding(vertical = 4.dp)) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(if (c.kind == "task") Line else InkText))
                Text(clockOf(c) ?: "all day", style = Type.readout, color = Muted, modifier = Modifier.width(64.dp))
                Text((if (c.kind == "task") "Task · " else "") + c.title, style = Type.body, color = InkText, modifier = Modifier.weight(1f),
                    maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun WaitingRow(w: Waiting, linked: List<String>, onAdd: (String) -> Unit, onDismiss: () -> Unit) {
    var busy by remember(w.id) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(CardPaper).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(listOfNotNull(if (w.kind == "todo") "TO-DO" else "EVENT", w.profile?.let { PROFILE[it]?.uppercase() }, w.when_?.let(::dayOf))
            .joinToString(" · "), style = Type.readout, color = Muted)
        Text(w.title, style = Type.block, color = InkText)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            val targets = w.profile?.let { listOf(it) } ?: listOf("work", "personal")
            for (where in targets) {
                if (where in linked) Button({ busy = true; onAdd(where) }, enabled = !busy, modifier = Modifier.height(44.dp),
                    shape = RoundedCornerShape(9.dp), colors = ButtonDefaults.buttonColors(containerColor = Hw, contentColor = HwText)) {
                    Text(when {
                        w.profile == null -> "Add to ${PROFILE[where]}"
                        w.kind == "todo" -> "Add to To-dos"
                        else -> "Add to Calendar"
                    }, style = Type.key)
                } else Text("Pick where ${PROFILE[where]} things go in Settings on the web first", style = Type.fine, color = Muted)
            }
            TextButton(onDismiss, enabled = !busy, modifier = Modifier.height(44.dp)) { Text("Skip", style = Type.body, color = Muted) }
        }
    }
}

@Composable
private fun Outbox(stuck: List<QueuedItem>, onClear: () -> Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Paper2).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Led(LedRed, "${stuck.size} could not be sent", wordColor = Red)
        stuck.forEach { Text("${it.kind}: ${it.problem}", style = Type.fine, color = InkText) }
        TextButton(onClear, contentPadding = PaddingValues(0.dp)) { Text("Clear these", style = Type.fine, color = Accent) }
    }
}

/**
 * One drop, as it rests on the shelf: the photo, the words (four lines, then
 * More), a voice note as its round key. Under it, one quiet line and two small
 * keys: the pencil for the note, the dots for everything else.
 */
@Composable
private fun EntryCard(e: ShelfEntry, links: Map<String, String>, reader: ShelfReader, player: Player, showProfile: Boolean,
                      added: Map<String, Int>, run: (suspend () -> String, () -> Unit) -> Unit) {
    var editing by remember(e.id) { mutableStateOf(false) }
    var removing by remember(e.id) { mutableStateOf(false) }
    var menu by remember(e.id) { mutableStateOf(false) }
    var more by remember(e.id) { mutableStateOf(false) }
    val voice = (if (e.kind == "voice") e.objectPath else e.voicePath)?.let { links[it] }
    Surface(color = Paper, shape = RoundedCornerShape(12.dp), border = androidx.compose.foundation.BorderStroke(1.dp, Line)) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (e.kind == "photo") Box {
                Thumbnail(e.objectPath, links, reader, e.description ?: "A photo on your Shelf")
                voice?.let {
                    VoiceKey(it, player, "Hear what you said about this photo", Modifier.align(Alignment.BottomStart).padding(10.dp)
                        .clip(RoundedCornerShape(24.dp)).background(Paper.copy(alpha = 0.9f)).padding(4.dp))
                }
            }
            if (e.kind == "voice") voice?.let { VoiceKey(it, player, "Play this voice note") }
            // A note's own words read at reading size; a link inside it shows as its page, not as an address.
            val (said, found) = remember(e.note) { splitLinks(e.note) }
            if (said.isNotBlank()) Text(said, color = InkText,
                style = if (e.kind != "note") Type.block else if (said.length <= 80) Type.block else Type.words)
            found.forEach { LinkCard(it, reader) }
            val words = e.transcript?.let { "“$it”" } ?: e.description
            words?.let {
                Text(it, fontFamily = Content, fontSize = 16.sp, lineHeight = 23.sp,
                    color = if (e.transcript == null && e.note.isNotBlank()) Muted else InkText,
                    maxLines = if (more) Int.MAX_VALUE else 4, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                if (it.length > 220) Text(if (more) "Less" else "More", color = Accent, fontSize = 13.sp,
                    modifier = Modifier.clickable { more = !more }.padding(vertical = 4.dp))
            }
            if (added.isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                Text("On " + added.entries.joinToString(", ") { "${it.key} (${it.value})" }, color = InkText, fontSize = 13.sp,
                    modifier = Modifier.weight(1f))
                TextButton({ run({ reader.undoLines(e.id); "Taken off your lists" }) {} }) { Text("Undo", color = Muted) }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(listOfNotNull(
                    when (e.kind) { "photo" -> "photo"; "voice" -> "voice"; else -> "note" },
                    e.addedBy?.let { "from $it" },
                    e.topicName,
                    if (showProfile) e.profile?.let { PROFILE[it] } else null,
                    dayOf(e.createdAt)?.lowercase(),
                    when (e.status) { "ready" -> null; "failed" -> "could not read"; else -> "reading…" },
                ).joinToString(" · "), color = Muted, fontSize = 13.sp, fontFamily = Mono,
                    maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (e.status == "ready" || e.status == "failed") IconButton({ editing = true }, Modifier.size(40.dp)) {
                    Icon(painterResource(R.drawable.ic_edit), if (e.note.isBlank()) "Add a note" else "Edit the note",
                        tint = Muted, modifier = Modifier.size(18.dp))
                }
                Box {
                    IconButton({ menu = true }, Modifier.size(40.dp)) {
                        Icon(painterResource(R.drawable.ic_more), "More for this one", tint = Muted, modifier = Modifier.size(18.dp))
                    }
                    DropdownMenu(menu, { menu = false }, containerColor = Paper) {
                        for ((key, label) in listOf("work" to "Move to Work", "personal" to "Move to Personal", null to "No profile")) {
                            DropdownMenuItem({ Text(label + if (e.profile == key) "  ✓" else "") }, enabled = e.profile != key, onClick = {
                                menu = false
                                run({ reader.setProfile(e.id, key); if (key == null) "Taken out of both profiles" else "Moved to ${PROFILE[key]}" }) {}
                            })
                        }
                        if (e.status == "ready" && e.sortedAt == null) DropdownMenuItem({ Text("Look for to-dos") }, onClick = {
                            menu = false
                            run({ reader.sort(e.id).let { n -> if (n == 0) "Nothing to do in this one" else "Found $n to do" } }) {}
                        })
                        if (e.status == "failed") DropdownMenuItem({ Text("Read again") }, onClick = {
                            menu = false
                            run({ reader.reread(e.id); "Reading it again" }) {}
                        })
                        HorizontalDivider(color = Line)
                        DropdownMenuItem({ Text("Remove…", color = Red) }, onClick = { menu = false; removing = true })
                    }
                }
            }
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

/** Voice note lengths already read, by link, so scrolling back does not read them again. */
private object Lengths {
    private val cache = android.util.LruCache<String, Int>(80)
    fun get(url: String): Int? = cache.get(url)
    fun put(url: String, ms: Int) { cache.put(url, ms) }
}

/** One voice note plays at a time; starting another stops the first. */
private class Player {
    var playing by mutableStateOf<String?>(null)
        private set
    var position by mutableIntStateOf(0)
        private set
    var length by mutableIntStateOf(0)
        private set
    private var media: MediaPlayer? = null
    fun toggle(url: String) {
        val again = playing == url
        stop()
        if (again) return
        media = MediaPlayer().apply {
            setAudioAttributes(AudioAttributes.Builder().setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            setDataSource(url)
            setOnPreparedListener { length = it.duration; it.start() }
            setOnCompletionListener { stop() }
            setOnErrorListener { _, _, _ -> stop(); true }
            prepareAsync()
        }
        playing = url
    }
    /** Read on a timer while playing, for the line beside the key. */
    fun tick() { position = runCatching { media?.currentPosition ?: 0 }.getOrDefault(0) }
    fun stop() { media?.release(); media = null; playing = null; position = 0; length = 0 }
}

/** A voice note as a round key, like the hardware keys: orange while playing, with a line that fills. */
@Composable
private fun VoiceKey(url: String, player: Player, label: String, modifier: Modifier = Modifier) {
    val on = player.playing == url
    LaunchedEffect(on) { while (on) { player.tick(); kotlinx.coroutines.delay(200) } }
    // The length at rest, read from the file's header without playing it.
    var length by remember(url) { mutableIntStateOf(Lengths.get(url) ?: 0) }
    LaunchedEffect(url) {
        if (length > 0) return@LaunchedEffect
        length = withContext(Dispatchers.IO) {
            runCatching {
                android.media.MediaMetadataRetriever().run {
                    try { setDataSource(url, emptyMap()); extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)?.toIntOrNull() ?: 0 }
                    finally { release() }
                }
            }.getOrDefault(0)
        }.also { if (it > 0) Lengths.put(url, it) }
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(if (on) Orange else Ink)
            .clickable { player.toggle(url) }
            .semantics { contentDescription = if (on) "Stop: $label" else label }, contentAlignment = Alignment.Center) {
            androidx.compose.foundation.Canvas(Modifier.size(14.dp)) {
                if (on) drawRect(Paper, topLeft = androidx.compose.ui.geometry.Offset(size.width * .15f, size.height * .15f),
                    size = androidx.compose.ui.geometry.Size(size.width * .7f, size.height * .7f))
                else drawPath(androidx.compose.ui.graphics.Path().apply {
                    moveTo(size.width * .2f, 0f); lineTo(size.width, size.height / 2); lineTo(size.width * .2f, size.height); close()
                }, Paper)
            }
        }
        if (on) {
            val share = if (player.length > 0) player.position.toFloat() / player.length else 0f
            Box(Modifier.width(120.dp).height(2.dp).background(Line)) {
                Box(Modifier.fillMaxWidth(share.coerceIn(0f, 1f)).fillMaxHeight().background(Orange))
            }
            Text("%d:%02d".format(player.position / 60000, player.position / 1000 % 60), color = Muted, fontSize = 13.sp,
                fontFamily = Mono)
        } else if (length > 0) Text("%d:%02d".format(length / 60000, length / 1000 % 60), color = Muted, fontSize = 13.sp,
            fontFamily = Mono)
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

/** One list on its own page: the name, how many are left in figures, a tick per line, and a fold of the done ones. */
@Composable
private fun ListPage(name: String, lines: List<ListLine>, names: List<String>, items: List<ShelfEntry>,
                     reader: ShelfReader, onRun: (suspend () -> String) -> Unit) {
    val open = lines.filter { it.status == "want" }
    val done = lines.filter { it.status == "done" }
    var showDone by remember(name) { mutableStateOf(false) }
    var openLine by remember(name) { mutableStateOf<String?>(null) }
    val kind = lines.firstOrNull()?.kind ?: "item"
    val doneWord = when (kind) { "expense" -> "claimed"; else -> "done" }
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    val owed = open.mapNotNull { l -> l.amount?.toBigDecimalOrNull()?.let { (l.currency ?: "") to it } }
        .groupBy({ it.first }, { it.second }).mapValues { (_, v) -> v.fold(java.math.BigDecimal.ZERO, java.math.BigDecimal::add) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 24.dp, bottom = 24.dp)) {
        item {
            Column(Modifier.padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(name, style = Type.page, color = InkText)
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(if (kind == "expense" && owed.isNotEmpty()) owed.entries.joinToString(" + ") { money(it.value, it.key.ifEmpty { null }) }
                        else open.size.toString(), style = Type.figure, color = InkText)
                    Text(when (kind) { "expense" -> "to claim"; "fact" -> "saved"; else -> "to go" } +
                        if (done.isNotEmpty()) " · ${done.size} $doneWord" else "", style = Type.fine, color = Muted)
                }
            }
        }
        if (open.isEmpty()) item { Text(if (kind == "expense") "All claimed." else "All done. New ones come from what you drop.", style = Type.body, color = Muted) }
        items(open + if (showDone) done else emptyList(), key = { it.id }) { line ->
            val isDone = line.status == "done"
            Column(Modifier.fillMaxWidth().background(if (openLine == line.id) Paper2 else Paper)) {
                Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable { openLine = if (openLine == line.id) null else line.id }
                    .padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (kind == "fact") IconButton({
                        clipboard.setText(androidx.compose.ui.text.AnnotatedString(line.detail ?: ""))
                        onRun { "Copied ${line.title}" }
                    }, Modifier.size(44.dp)) { Icon(painterResource(R.drawable.ic_copy), "Copy ${line.title}", tint = Muted, modifier = Modifier.size(20.dp)) }
                    else Checkbox(isDone, { on -> onRun { reader.tick(line.id, on); if (on) "${doneWord.replaceFirstChar { it.uppercase() }}: ${line.title}" else "Back on $name" } },
                        colors = CheckboxDefaults.colors(checkedColor = Hw, uncheckedColor = Muted))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (kind == "fact") Text(line.title.uppercase(), style = Type.readout, color = Muted)
                        Text(if (kind == "fact") line.detail ?: "" else line.title,
                            style = if (kind == "fact") Type.readout.copy(fontSize = 16.sp, letterSpacing = 0.sp) else Type.block,
                            color = if (isDone) Muted else InkText,
                            textDecoration = if (isDone) androidx.compose.ui.text.style.TextDecoration.LineThrough else null)
                        if (kind == "expense") Text(listOfNotNull(line.spentOn?.let(::dayOf), if (line.profile == "work") "WORK" else null)
                            .joinToString(" · "), style = Type.readout, color = Muted)
                        else if (kind == "item") line.detail?.let { Text(it, style = Type.fine, color = if (isDone) Muted else Muted) }
                    }
                    if (kind == "expense") Text(moneyOf(line), style = Type.readout.copy(fontSize = 16.sp, letterSpacing = 0.sp),
                        color = if (isDone) Muted else InkText)
                }
                if (openLine == line.id) Column(Modifier.padding(start = 56.dp, end = 8.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    line.itemIds.mapNotNull { id -> items.find { it.id == id } }.forEach { e ->
                        Text("from “" + (listOf(e.note, e.transcript, e.description).firstOrNull { !it.isNullOrBlank() } ?: "a drop").take(120) + "”",
                            style = Type.fine, color = Muted)
                    }
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        if (kind == "item") names.filter { it != name && it.lowercase() !in setOf("expenses", "good to know") }.take(3).forEach { other ->
                            Chip("→ $other", { onRun { reader.moveLine(line.id, other); "Moved to $other" } })
                        }
                        TextButton({ onRun { reader.removeLine(line.id); "Removed ${line.title}" } }, Modifier.height(44.dp)) { Text("Remove", style = Type.body, color = Red) }
                    }
                }
                HorizontalDivider(color = Line)
            }
        }
        if (done.isNotEmpty()) item {
            TextButton({ showDone = !showDone }, Modifier.padding(top = 8.dp)) {
                Text(if (showDone) "Hide ${doneWord}" else "${doneWord.replaceFirstChar { it.uppercase() }} · ${done.size}", style = Type.body, color = Accent)
            }
        }
    }
}

/** When the first thing coming up starts, for the figure on the Shelf: a clock today, else the day. */
private fun timeOf(c: Coming): String = runCatching {
    c.at?.let {
        val at = OffsetDateTime.parse(it).atZoneSameInstant(java.time.ZoneId.systemDefault())
        if (at.toLocalDate() == LocalDate.now()) at.format(DateTimeFormatter.ofPattern("HH:mm")) else at.format(DateTimeFormatter.ofPattern("EEE"))
    } ?: c.day?.let { LocalDate.parse(it).format(DateTimeFormatter.ofPattern("EEE")) } ?: "—"
}.getOrDefault("—")

private fun dayLabel(c: Coming): String = runCatching {
    val day = c.at?.let { OffsetDateTime.parse(it).atZoneSameInstant(java.time.ZoneId.systemDefault()).toLocalDate() } ?: c.day?.let(LocalDate::parse)
    when (day) { null -> "No date"; LocalDate.now() -> "Today"; LocalDate.now().plusDays(1) -> "Tomorrow"; else -> day.format(SHORT_DAY) }
}.getOrDefault("")

private fun clockOf(c: Coming): String? = runCatching {
    c.at?.let { OffsetDateTime.parse(it).atZoneSameInstant(java.time.ZoneId.systemDefault()) }
        // Midnight to midnight is how calendars write a day off; it reads as all day, not "00:00".
        ?.takeUnless { it.hour == 0 && it.minute == 0 }?.format(DateTimeFormatter.ofPattern("HH:mm"))
}.getOrNull()

private fun startsLater(c: Coming): Boolean = runCatching {
    val at = OffsetDateTime.parse(c.at ?: return false)
    at.toInstant().isAfter(java.time.Instant.now()) && clockOf(c) != null
}.getOrDefault(false)

/** An amount short enough for a figure: ₹2.5k, $640. */
private fun short(n: java.math.BigDecimal, currency: String?): String {
    val symbol = runCatching { java.util.Currency.getInstance(currency!!).symbol }.getOrDefault("")
    val v = n.toDouble()
    return symbol + when {
        v >= 100_000 -> "%.1fL".format(v / 100_000).replace(".0L", "L")
        v >= 1_000 -> "%.1fk".format(v / 1_000).replace(".0k", "k")
        else -> "%.0f".format(v)
    }
}

/** An amount as printed: ₹2,340, $23.40, or the bare number when no currency was shown. */
private fun moneyOf(line: ListLine): String = line.amount?.toBigDecimalOrNull()?.let { money(it, line.currency) } ?: "amount?"

/** An amount as a receipt shows it, with no ".00" on a whole one. */
private fun money(n: java.math.BigDecimal, currency: String?): String {
    val whole = n.stripTrailingZeros().scale() <= 0
    return runCatching {
        java.text.NumberFormat.getCurrencyInstance().apply {
            this.currency = java.util.Currency.getInstance(currency!!)
            if (whole) { minimumFractionDigits = 0; maximumFractionDigits = 0 }
        }.format(n)
    }.getOrElse { java.text.DecimalFormat(if (whole) "#,##0" else "#,##0.00").format(n) }
}
