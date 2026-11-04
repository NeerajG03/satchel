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
        setContent { SatchelTheme { Capture(this, mode, onDone = ::done, onCancel = ::finish) } }
    }

    private fun done(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
        sendSoon()
        finish()
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

@Composable
private fun Capture(activity: ComponentActivity, mode: String, onDone: (String) -> Unit, onCancel: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var cameraAllowed by remember { mutableStateOf(granted(context, Manifest.permission.CAMERA)) }
    var micAllowed by remember { mutableStateOf(granted(context, Manifest.permission.RECORD_AUDIO)) }
    var shot by remember { mutableStateOf<Shot?>(null) }
    var recorder by remember { mutableStateOf<VoiceRecorder?>(null) }
    var seconds by remember { mutableIntStateOf(0) }
    var typing by remember { mutableStateOf(mode == "note") }
    var note by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val camera = remember { CameraKit() }

    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { cameraAllowed = it }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        micAllowed = it
        if (!it) problem = "Satchel needs the microphone to hear you. Allow it in Settings."
    }
    LaunchedEffect(Unit) { if (!cameraAllowed && mode != "note" && mode != "voice") askCamera.launch(Manifest.permission.CAMERA) }
    LaunchedEffect(cameraAllowed, typing) { if (cameraAllowed && !typing) camera.bind(activity) }
    DisposableEffect(Unit) { onDispose { recorder?.discard() } }
    LaunchedEffect(recorder) { seconds = 0; while (recorder != null) { delay(1000); seconds++ } }

    fun startTalking(): Boolean {
        if (!micAllowed) { askMic.launch(Manifest.permission.RECORD_AUDIO); return false }
        return runCatching { recorder = VoiceRecorder(context).also { it.start() } }
            .onFailure { problem = "The microphone is busy. Try again in a moment." }.isSuccess
    }

    /** Saves whatever is in hand: a photo, what was said, what was typed, or any of them together. */
    fun save(voice: ByteArray?) {
        val photo = shot
        val words = note.trim()
        busy = true
        scope.launch {
            val kept = withContext(Dispatchers.IO) {
                runCatching {
                    val queue = context.app.queue
                    when {
                        photo != null && voice != null -> queue.addPhotoWithVoice(photo.bytes, voice, words).let { "Photo and what you said saved" }
                        photo != null -> queue.addFile("photo", "image/jpeg", photo.bytes, words).let { "Photo saved to your Shelf" }
                        voice != null -> queue.addFile("voice", "audio/mp4", voice, words).let { "Voice note saved to your Shelf" }
                        else -> queue.addNote(words).let { "Saved to your Shelf" }
                    }
                }
            }
            busy = false
            kept.onSuccess(onDone).onFailure { problem = "Satchel could not keep that. Try again." }
        }
    }

    fun stopTalking() {
        val r = recorder ?: return
        recorder = null
        scope.launch {
            val voice = withContext(Dispatchers.IO) { r.stop() }
            if (voice == null) problem = "That was too short to keep. Hold a little longer." else save(voice)
        }
    }

    fun takePhoto() {
        busy = true
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
                busy = false
                if (made == null) problem = "The photo did not come out. Try again." else { shot = made; problem = null }
            }
        }
    }

    // Voice from the widget starts listening at once: one tap to open, one to save.
    LaunchedEffect(Unit) { if (mode == "voice") startTalking() }

    Box(Modifier.fillMaxSize().background(Black)) {
        val current = shot
        when {
            current != null -> Image(current.picture, "The photo you just took", Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
            cameraAllowed && !typing -> camera.request?.let { CameraXViewfinder(surfaceRequest = it, modifier = Modifier.fillMaxSize()) }
            !typing -> Column(Modifier.align(Alignment.Center).padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("No camera yet. Hold the button to talk, or type.", color = Paper, fontSize = 16.sp)
                OutlinedButton({ askCamera.launch(Manifest.permission.CAMERA) }) { Text("Use the camera", color = Paper) }
            }
        }

        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onCancel) { Text("Close", color = Paper, fontSize = 16.sp) }
            Spacer(Modifier.weight(1f))
            if (!typing) TextButton({ typing = true }) { Text("Type", color = Paper, fontSize = 16.sp) }
        }

        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().navigationBarsPadding().imePadding()
                .background(if (typing) Paper else Color.Transparent, RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp))
                .padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            problem?.let { Text(it, color = if (typing) Red else Color(0xFFFFB4A8), fontSize = 14.sp) }
            if (typing) {
                NoteBox(note) { note = it }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    TextButton({ typing = false }) { Text(if (shot != null) "Back to the photo" else "Camera", color = Muted) }
                    Spacer(Modifier.weight(1f))
                    Button({ save(null) }, enabled = !busy && (note.isNotBlank() || shot != null),
                        colors = ButtonDefaults.buttonColors(containerColor = InkText, contentColor = Paper)) { Text("Save") }
                }
                return@Column
            }
            val recording = recorder != null
            Text(
                when {
                    recording -> "Listening ${seconds / 60}:${"%02d".format(seconds % 60)} · let go or tap to save"
                    shot != null -> "Hold to say what this is · or Save the photo as it is"
                    cameraAllowed -> "Tap for a photo · hold to talk"
                    else -> "Hold to talk"
                },
                color = Paper, fontSize = 14.sp,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(96.dp), contentAlignment = Alignment.Center) {
                    if (shot != null && !recording) TextButton({ shot = null }) { Text("Retake", color = Paper) }
                }
                ShutterKey(
                    recording = recording, hasShot = shot != null, enabled = !busy,
                    onTap = {
                        when {
                            recorder != null -> stopTalking()
                            shot != null -> startTalking()
                            cameraAllowed -> takePhoto()
                            else -> startTalking()
                        }
                    },
                    onHoldStart = { startTalking() },
                    onHoldEnd = { stopTalking() },
                )
                Box(Modifier.width(96.dp), contentAlignment = Alignment.Center) {
                    if (shot != null && !recording) Button({ save(null) }, enabled = !busy,
                        colors = ButtonDefaults.buttonColors(containerColor = Paper, contentColor = InkText)) { Text("Save") }
                }
            }
        }
    }
}

/** Tap to act, hold to talk: talking starts as soon as a press turns into a hold, and saves on release. */
@Composable
private fun ShutterKey(recording: Boolean, hasShot: Boolean, enabled: Boolean,
                       onTap: () -> Unit, onHoldStart: () -> Boolean, onHoldEnd: () -> Unit) {
    val scope = rememberCoroutineScope()
    val tap by rememberUpdatedState(onTap)
    val holdStart by rememberUpdatedState(onHoldStart)
    val holdEnd by rememberUpdatedState(onHoldEnd)
    val wasRecording by rememberUpdatedState(recording)
    Box(
        Modifier.size(88.dp)
            .border(4.dp, Paper, CircleShape).padding(8.dp)
            .background(if (recording) Red else if (hasShot) Orange else Paper, CircleShape)
            .semantics {
                contentDescription = when {
                    recording -> "Stop and save"
                    hasShot -> "Hold to say what this photo is"
                    else -> "Tap for a photo, hold to talk"
                }
            }
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectTapGestures(onPress = {
                    if (wasRecording) { tryAwaitRelease(); tap(); return@detectTapGestures }
                    var holding = false
                    val hold: Job = scope.launch { delay(350); holding = holdStart() }
                    tryAwaitRelease()
                    hold.cancel()
                    if (holding) holdEnd() else tap()
                })
            },
        contentAlignment = Alignment.Center,
    ) {
        if (recording) Text("■", color = Paper, fontSize = 28.sp, fontWeight = FontWeight.Bold)
        else if (hasShot) Icon(painterResource(R.drawable.ic_voice), null, tint = Paper, modifier = Modifier.size(30.dp))
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
}
