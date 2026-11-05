package app.satchel.capture

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.media.MediaRecorder
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.compose.CameraXViewfinder
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceRequest
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.lifecycle.awaitInstance
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.animation.core.animateFloat
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/**
 * The one screen every quick way in opens: Quick Tap on the back of the phone,
 * the widget, the tile and the app. It opens on the camera, ready:
 * tap for a photo, hold to talk, or type. After a photo, hold to say what it
 * is, and the two are saved as one item. It also opens over the lock screen,
 * like the camera does: it can put things on the Shelf, never show them.
 */
class CaptureActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        if (!app.auth.signedIn) {
            Toast.makeText(this, "Sign in to Satchel first.", Toast.LENGTH_LONG).show()
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return finish()
        }
        // The Quick Tap entry is a second launcher name for this screen, so it carries no mode.
        val mode = intent.getStringExtra(EXTRA_MODE) ?: "camera"
        setContent { SatchelTheme { Capture(this, mode, onClose = ::finish) } }
    }

    companion object {
        const val EXTRA_MODE = "mode"
        fun intent(context: Context, mode: String) = Intent(context, CaptureActivity::class.java)
            .putExtra(EXTRA_MODE, mode)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    }
}

private val Black = Color(0xFF111010)

/** A photo just taken: the bytes that will be queued, and a picture of them to show. */
private class Shot(val bytes: ByteArray, val picture: ImageBitmap)

/** Where a press is now, for the hints around the key while it is held. */
private enum class Drag { NONE, TOWARD_LOCK, TOWARD_CANCEL }

/**
 * One touch: point at it, press the key and talk, let go. The photo is taken
 * the moment the key goes down (you are already pointing), the microphone
 * listens while it is held, and letting go saves both as one drop. Slide up to
 * keep talking hands-free; slide left to throw it away. A quick tap is just a
 * photo. The mic key beside it turns the camera off for a voice note alone;
 * Type writes one. Back closes, as everywhere on Android.
 */
@Composable
private fun Capture(activity: ComponentActivity, mode: String, onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var cameraAllowed by remember { mutableStateOf(granted(context, Manifest.permission.CAMERA)) }
    var micAllowed by remember { mutableStateOf(granted(context, Manifest.permission.RECORD_AUDIO)) }
    var typing by remember { mutableStateOf(mode == "note") }
    var note by remember { mutableStateOf("") }
    var shot by remember { mutableStateOf<kotlinx.coroutines.Deferred<Shot?>?>(null) }
    var shotPicture by remember { mutableStateOf<ImageBitmap?>(null) }
    var recorder by remember { mutableStateOf<VoiceRecorder?>(null) }
    var locked by remember { mutableStateOf(false) }
    var drag by remember { mutableStateOf(Drag.NONE) }
    // Talking from the voice key: no photo, and the big key steps aside.
    var talkingOnly by remember { mutableStateOf(false) }
    var seconds by remember { mutableIntStateOf(0) }
    var level by remember { mutableIntStateOf(0) }
    var problem by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf<Saved?>(null) }
    val camera = remember { CameraKit() }

    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { cameraAllowed = it }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        micAllowed = it
        if (!it) problem = "Satchel needs the microphone to hear you. Allow it in Settings."
    }
    LaunchedEffect(Unit) { if (!cameraAllowed && mode != "note" && mode != "voice") askCamera.launch(Manifest.permission.CAMERA) }
    LaunchedEffect(cameraAllowed, typing) { if (cameraAllowed && !typing) camera.bind(activity) }
    DisposableEffect(Unit) { onDispose { recorder?.discard() } }
    LaunchedEffect(recorder) {
        seconds = 0
        var ticks = 0
        while (recorder != null) { delay(100); level = recorder?.level() ?: 0; if (++ticks % 10 == 0) seconds++ }
    }

    fun reset() { talkingOnly = false; shot = null; shotPicture = null; recorder?.discard(); recorder = null; locked = false; drag = Drag.NONE; note = ""; problem = null }

    fun snap() {
        if (!cameraAllowed) return
        val pending = kotlinx.coroutines.CompletableDeferred<Shot?>()
        shot = pending
        camera.take(context) { result ->
            scope.launch {
                val made = result?.let { file ->
                    withContext(Dispatchers.Default) {
                        runCatching {
                            val bytes = Photos.shrink(context, file.toUri())
                            Shot(bytes, BitmapFactory.decodeByteArray(bytes, 0, bytes.size).asImageBitmap())
                        }.getOrNull().also { file.delete() }
                    }
                }
                shotPicture = made?.picture
                if (made == null) problem = "The photo did not come out. Try again."
                pending.complete(made)
            }
        }
    }

    fun listen(): Boolean {
        if (!micAllowed) { askMic.launch(Manifest.permission.RECORD_AUDIO); return false }
        return runCatching { recorder = VoiceRecorder(context).also { it.start() } }
            .onFailure { problem = "The microphone is busy. Try again in a moment." }.isSuccess
    }

    // From the widget's voice key: hands-free at once.
    LaunchedEffect(Unit) { if (mode == "voice") { talkingOnly = true; if (listen()) locked = true else talkingOnly = false } }

    /** Saves what is in hand, as one drop, then shows it reaching the Shelf. */
    fun save(withVoice: Boolean) {
        val r = recorder
        recorder = null; locked = false; drag = Drag.NONE
        scope.launch {
            val voice = if (withVoice && r != null) withContext(Dispatchers.IO) { r.stop() } else { r?.discard(); null }
            if (withVoice && voice == null && shot == null) { problem = "That was too short to keep. Hold a little longer."; return@launch }
            val photo = shot?.await()
            val words = note.trim()
            if (photo == null && voice == null && words.isEmpty()) return@launch
            val kept = withContext(Dispatchers.IO) {
                runCatching {
                    val queue = context.app.queue
                    when {
                        photo != null && voice != null -> queue.addPhotoWithVoice(photo.bytes, voice, words)
                        photo != null -> queue.addFile("photo", "image/jpeg", photo.bytes, words)
                        voice != null -> queue.addFile("voice", "audio/mp4", voice, words)
                        else -> queue.addNote(words)
                    }
                }
            }
            kept.onSuccess { item ->
                context.sendSoon()
                saved = Saved(item.id, photo?.picture, when {
                    photo != null && voice != null -> "PHOTO + VOICE"
                    photo != null -> "PHOTO"
                    voice != null -> "VOICE"
                    else -> "NOTE"
                }, words)
                shot = null; shotPicture = null; note = ""; typing = false
            }.onFailure { problem = "Satchel could not keep that. Try again." }
        }
    }

    saved?.let { s ->
        SavedSheet(s, onAnother = { saved = null; reset() }, onDone = onClose)
        return
    }

    Box(Modifier.fillMaxSize().background(Black)) {
        when {
            typing -> {}
            !cameraAllowed -> Column(Modifier.align(Alignment.Center).padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Led(if (recorder != null) Orange else LedOff, "no camera yet", wordColor = HwText)
                HardwareKey("Use the camera", { askCamera.launch(Manifest.permission.CAMERA) })
            }
            else -> camera.request?.let { CameraXViewfinder(surfaceRequest = it, modifier = Modifier.fillMaxSize()) }
        }

        // The photo, pinned to the corner the moment it is taken.
        shotPicture?.let { picture ->
            Row(Modifier.statusBarsPadding().padding(16.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Image(picture, "The photo, taken when you pressed", Modifier.size(64.dp, 84.dp).rotate(-3f)
                    .clip(RoundedCornerShape(8.dp)).border(2.dp, Paper, RoundedCornerShape(8.dp)), contentScale = ContentScale.Crop)
                Text("PHOTO TAKEN", style = Type.readout, color = HwText,
                    modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(Hw.copy(alpha = .8f)).padding(horizontal = 10.dp, vertical = 6.dp))
            }
        }

        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().navigationBarsPadding().imePadding().padding(8.dp)
            .clip(RoundedCornerShape(14.dp)).background(if (typing) Paper else Hw).padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            problem?.let { Text(it, style = Type.fine, color = if (typing) Red else Color(0xFFFFB4A8)) }
            if (typing) {
                NoteBox(note) { note = it }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    TextButton({ typing = false }) { Text(if (shotPicture != null) "Back to the photo" else "Camera", style = Type.body, color = Muted) }
                    Spacer(Modifier.weight(1f))
                    Button({ save(false) }, enabled = note.isNotBlank() || shot != null, modifier = Modifier.height(48.dp),
                        shape = RoundedCornerShape(9.dp), colors = ButtonDefaults.buttonColors(containerColor = Hw, contentColor = HwText)) {
                        Text("Save", style = Type.key)
                    }
                }
                return@Column
            }
            val listening = recorder != null
            Row(Modifier.fillMaxWidth().heightIn(min = 24.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                if (listening) {
                    Led(Orange, if (locked) "listening · hands-free %d:%02d".format(seconds / 60, seconds % 60)
                        else "listening %d:%02d".format(seconds / 60, seconds % 60), wordColor = HwText)
                    Spacer(Modifier.width(12.dp))
                    Levels(level)
                } else Text(if (cameraAllowed) "TAP · PHOTO    HOLD · SHOW AND TELL" else "HOLD THE MIC · TALK",
                    style = Type.readout, color = HwMuted)
            }
            Box(Modifier.fillMaxWidth().height(140.dp)) {
                if (listening && !locked) {
                    Column(Modifier.align(Alignment.TopCenter), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("↑ LOCK", style = Type.readout, color = if (drag == Drag.TOWARD_LOCK) Orange else HwMuted)
                    }
                    Text("✕ ← SLIDE TO CANCEL", style = Type.readout, color = if (drag == Drag.TOWARD_CANCEL) LedRed else HwMuted,
                        modifier = Modifier.align(Alignment.CenterStart))
                }
                if (locked) HardwareKey("Cancel", { recorder?.discard(); recorder = null; locked = false; shot = null; shotPicture = null },
                    Modifier.align(Alignment.CenterStart))
                if (!listening) SideKey("Type", Modifier.align(Alignment.CenterStart)) { typing = true }
                // The voice key works like the big one, without the photo: hold to talk, let go to save,
                // slide up for hands-free, slide left to throw it away; a tap starts hands-free.
                if (!listening || talkingOnly) ShutterKey(listening = listening && talkingOnly, locked = locked && talkingOnly, camera = false,
                    size = 64.dp, modifier = Modifier.align(Alignment.CenterEnd),
                    onDown = { problem = null; talkingOnly = true },
                    onHold = { listen() },
                    onDrag = { drag = it },
                    onLock = { locked = true; drag = Drag.NONE },
                    onCancel = { recorder?.discard(); recorder = null; drag = Drag.NONE; talkingOnly = false },
                    onRelease = { save(withVoice = true); talkingOnly = false },
                    onTap = {
                        when {
                            locked -> { save(withVoice = true); talkingOnly = false }
                            recorder == null -> { if (listen()) locked = true else talkingOnly = false }
                        }
                    })
                if (!talkingOnly) ShutterKey(listening = listening, locked = locked, camera = cameraAllowed,
                    modifier = Modifier.align(Alignment.Center),
                    onDown = { problem = null; snap() },
                    onHold = { listen() },
                    onDrag = { drag = it },
                    onLock = { locked = true; drag = Drag.NONE },
                    onCancel = { recorder?.discard(); recorder = null; drag = Drag.NONE; shot = null; shotPicture = null },
                    onRelease = { save(withVoice = true) },
                    onTap = {
                        when {
                            locked -> save(withVoice = true)
                            cameraAllowed -> save(withVoice = false)
                            recorder == null -> { if (listen()) locked = true }
                        }
                    })
            }
            if (!listening) Text("Point at it first. The photo is taken the moment you press.", style = Type.fine, color = HwMuted)
            else if (!locked) Text(if (talkingOnly) "Let go to save · a voice note" else "Let go to save · photo and your words, one drop",
                style = Type.fine, color = HwText)
            else Text(if (talkingOnly) "Tap the mic to finish · saved as a voice note" else "Tap the key to finish · saved as one drop",
                style = Type.fine, color = HwText)
        }
    }
}

/** A short key beside the big one, on the hardware. */
@Composable
private fun SideKey(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) =
    HardwareKey(label, onClick, modifier, height = 48.dp)

/** How loud it is, as five bars: the honest sign it is hearing you. */
@Composable
private fun Levels(level: Int) {
    val share = (level / 12000f).coerceIn(0.1f, 1f)
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.height(20.dp)) {
        listOf(.5f, .9f, 1f, .7f, .4f).forEach { w ->
            Box(Modifier.width(3.dp).height((20 * (w * share).coerceAtLeast(.2f)).dp).clip(RoundedCornerShape(2.dp)).background(Orange))
        }
    }
}

/**
 * The big key. Down takes the photo; held past a moment, it listens; a slide up
 * locks it, a slide left throws it away; up saves. A quick tap is a photo, or,
 * locked, the end of talking.
 */
@Composable
private fun ShutterKey(listening: Boolean, locked: Boolean, camera: Boolean, modifier: Modifier = Modifier, size: Dp = 88.dp,
                       onDown: () -> Unit, onHold: () -> Boolean, onDrag: (Drag) -> Unit, onLock: () -> Unit,
                       onCancel: () -> Unit, onRelease: () -> Unit, onTap: () -> Unit) {
    val scope = rememberCoroutineScope()
    val density = androidx.compose.ui.platform.LocalDensity.current
    val far = with(density) { 72.dp.toPx() }
    val near = with(density) { 24.dp.toPx() }
    val cb by rememberUpdatedState(listOf(onDown, onRelease, onTap, onLock, onCancel))
    val hold by rememberUpdatedState(onHold)
    val dragTo by rememberUpdatedState(onDrag)
    val isLocked by rememberUpdatedState(locked)
    val pulse = androidx.compose.animation.core.rememberInfiniteTransition(label = "pulse")
    val ring by pulse.animateFloat(1f, 1.5f, androidx.compose.animation.core.infiniteRepeatable(
        androidx.compose.animation.core.tween(1200, easing = androidx.compose.animation.core.CubicBezierEasing(.2f, .7f, .2f, 1f))), label = "ring")
    Box(modifier.size(size + 16.dp), contentAlignment = Alignment.Center) {
        if (listening) Box(Modifier.size(size).scale(ring).alpha((1.5f - ring) * 1f).border(3.dp, Orange, CircleShape))
        Box(
            Modifier.size(size).clip(CircleShape)
                .background(if (listening) (if (locked) HwKey else Orange) else HwKey)
                .border(if (camera) 4.dp else 2.dp, if (listening) Orange else if (camera) HwText else HwMuted, CircleShape)
                .padding(if (camera) 8.dp else 4.dp)
                .semantics {
                    contentDescription = when {
                        locked -> "Finish and save"
                        listening -> "Let go to save the photo and what you said"
                        camera -> "Tap for a photo, hold to show it and say it"
                        else -> "Voice note: hold to talk and let go to save, or tap to talk hands-free"
                    }
                }
                .pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        if (isLocked) { waitForUpOrCancellation(); cb[2](); return@awaitEachGesture }
                        cb[0]()
                        var holding = false
                        val job = scope.launch { delay(300); holding = hold() }
                        var ended = "up"
                        while (true) {
                            val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                            val dx = change.position.x - down.position.x
                            val dy = change.position.y - down.position.y
                            if (holding) {
                                dragTo(when { -dy > near && -dy > -dx -> Drag.TOWARD_LOCK; -dx > near -> Drag.TOWARD_CANCEL; else -> Drag.NONE })
                                if (-dy > far) { ended = "lock"; break }
                                if (-dx > far) { ended = "cancel"; break }
                            }
                            if (!change.pressed) break
                        }
                        job.cancel()
                        when {
                            ended == "lock" -> cb[3]()
                            ended == "cancel" -> cb[4]()
                            holding -> cb[1]()
                            else -> cb[2]()
                        }
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            when {
                locked -> Box(Modifier.size(28.dp).clip(RoundedCornerShape(4.dp)).background(Orange))
                listening -> {}
                camera -> Box(Modifier.fillMaxSize().clip(CircleShape).background(HwText))
                else -> Icon(painterResource(R.drawable.ic_voice), null, tint = HwText, modifier = Modifier.size(if (size < 80.dp) 24.dp else 32.dp))
            }
        }
    }
}

/** A drop just made, until it is seen to reach the Shelf. */
private class Saved(val id: String, val picture: ImageBitmap?, val kind: String, val words: String)

/**
 * The end of a capture: amber while it is only on the phone, green with one
 * ring once Satchel has it. Green appears only when that is true.
 */
@Composable
private fun SavedSheet(s: Saved, onAnother: () -> Unit, onDone: () -> Unit) {
    val context = LocalContext.current
    var state by remember(s.id) { mutableStateOf("sending") }
    LaunchedEffect(s.id) {
        repeat(60) {
            val mine = context.app.queue.pending().firstOrNull { it.id == s.id }
            state = when { mine == null -> "on shelf"; mine.problem != null -> "stuck"; else -> "sending" }
            if (state != "sending") return@LaunchedEffect
            delay(500)
        }
    }
    val verified = state == "on shelf"
    val ring by androidx.compose.animation.core.animateFloatAsState(if (verified) 1f else 0f,
        androidx.compose.animation.core.tween(900, easing = androidx.compose.animation.core.CubicBezierEasing(.2f, .7f, .2f, 1f)), label = "verify")
    Box(Modifier.fillMaxSize().background(Black)) {
        s.picture?.let { Image(it, "What you just dropped", Modifier.fillMaxSize().alpha(.55f), contentScale = ContentScale.Crop) }
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().navigationBarsPadding().padding(8.dp)
            .clip(RoundedCornerShape(14.dp)).background(Hw).padding(start = 16.dp, end = 16.dp, top = 24.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) {
                    if (verified) Box(Modifier.size(12.dp).scale(1f + ring * 1.3f).alpha(1f - ring).border(2.dp, LedGreen, CircleShape))
                    Box(Modifier.size(12.dp).clip(CircleShape).background(when (state) { "on shelf" -> LedGreen; "stuck" -> LedRed; else -> LedAmber }))
                }
                Text(when (state) { "on shelf" -> "ON YOUR SHELF"; "stuck" -> "COULD NOT SEND"; else -> "SAVED ON THE PHONE · SENDING" },
                    style = Type.readout, color = HwText, modifier = Modifier.weight(1f))
                Text(s.kind, style = Type.readout, color = HwMuted)
            }
            if (s.words.isNotBlank()) Text("“${s.words}”", style = Type.block, color = Paper)
            Text(when (state) {
                "on shelf" -> "Satchel is reading it. Titles land on your lists in a moment."
                "stuck" -> "It is kept on the phone. Open Satchel to see why."
                else -> "It goes as soon as there is a connection. You can close this."
            }, style = Type.fine, color = HwMuted)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                HardwareKey("Drop another", onAnother, Modifier.weight(1f), height = 56.dp)
                HardwareKey("Done", onDone, Modifier.weight(1f), height = 56.dp, selected = true)
            }
        }
    }
}

@Composable
private fun NoteBox(value: String, onChange: (String) -> Unit) {
    val focus = remember { FocusRequester() }
    OutlinedTextField(
        value = value, onValueChange = { onChange(it.take(ShelfTypes.NOTE_LIMIT)) },
        label = { Text("Note") }, minLines = 2, maxLines = 6,
        modifier = Modifier.fillMaxWidth().focusRequester(focus),
    )
    LaunchedEffect(Unit) { focus.requestFocus() }
}

private fun granted(context: Context, permission: String) =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

/** The back camera, bound to the screen's life: a preview to show and a still to take. */
private class CameraKit {
    var request by mutableStateOf<SurfaceRequest?>(null)
        private set
    private val still = ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build()
    private val preview = Preview.Builder().build().apply { setSurfaceProvider { request = it } }

    suspend fun bind(activity: ComponentActivity) {
        val provider = ProcessCameraProvider.awaitInstance(activity)
        runCatching {
            provider.unbindAll()
            provider.bindToLifecycle(activity, CameraSelector.DEFAULT_BACK_CAMERA, preview, still)
        }
    }

    /** The photo as a file in the cache, or null when it did not come out. */
    fun take(context: Context, done: (File?) -> Unit) {
        val file = File(context.cacheDir, "camera/${UUID.randomUUID()}.jpg").apply { parentFile?.mkdirs() }
        still.takePicture(ImageCapture.OutputFileOptions.Builder(file).build(), ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) = done(file)
                override fun onError(error: ImageCaptureException) { file.delete(); done(null) }
            })
    }
}

/** AAC in an M4A file: small, and a type the Shelf and the model both read. */
private class VoiceRecorder(context: Context) {
    private val file = File(context.cacheDir, "voice/${UUID.randomUUID()}.m4a").apply { parentFile?.mkdirs() }
    private val recorder = MediaRecorder(context)
    private var startedAt = 0L

    fun start() {
        recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
        recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        recorder.setAudioSamplingRate(44100)
        recorder.setAudioEncodingBitRate(64000)
        recorder.setAudioChannels(1)
        recorder.setOutputFile(file)
        recorder.prepare()
        recorder.start()
        startedAt = System.currentTimeMillis()
    }

    /** The recording, or null when it was under a second or could not be finished. */
    fun stop(): ByteArray? {
        val long = System.currentTimeMillis() - startedAt >= 1000
        val ok = runCatching { recorder.stop() }.isSuccess
        recorder.release()
        val bytes = if (ok && long) file.readBytes() else null
        file.delete()
        return bytes
    }

    fun discard() { runCatching { recorder.stop() }; recorder.release(); file.delete() }

    /** How loud it was since the last ask, 0 to 32767. */
    fun level(): Int = runCatching { recorder.maxAmplitude }.getOrDefault(0)
}
