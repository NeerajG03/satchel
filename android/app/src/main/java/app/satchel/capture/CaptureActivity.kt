package app.satchel.capture

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import kotlinx.coroutines.delay
import java.io.File
import java.util.UUID

/**
 * The one sheet every quick way in opens: the widget, the tile and the app.
 * `mode` picks what is ready first: "photo" goes straight to the camera,
 * "voice" to the record button, "note" to the keyboard, "pick" shows all three.
 * Saving closes the sheet at once; sending happens in the background.
 */
class CaptureActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!app.auth.signedIn) {
            Toast.makeText(this, "Sign in to Satchel first.", Toast.LENGTH_LONG).show()
            startActivity(Intent(this, MainActivity::class.java))
            return finish()
        }
        val mode = intent.getStringExtra(EXTRA_MODE) ?: "pick"
        setContent { SatchelTheme { CaptureSheet(mode, onDone = ::done, onCancel = ::finish) } }
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

@Composable
private fun CaptureSheet(mode: String, onDone: (String) -> Unit, onCancel: () -> Unit) {
    val context = LocalContext.current
    var note by rememberSaveable { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // Kept across a rebuild: the camera app can push this screen out of memory,
    // and the photo it took has to land in the same file we gave it.
    val photoPath = rememberSaveable { "camera/${UUID.randomUUID()}.jpg" }
    var cameraOpened by rememberSaveable { mutableStateOf(false) }
    val photoFile = remember(photoPath) { File(context.cacheDir, photoPath).apply { parentFile?.mkdirs() } }
    val photoUri = remember(photoFile) { FileProvider.getUriForFile(context, "${context.packageName}.files", photoFile) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
        if (!taken) { if (mode == "photo") onCancel(); return@rememberLauncherForActivityResult }
        // Shrinking a large photo takes long enough to freeze the screen, so it runs off it.
        scope.launch {
            val kept = withContext(Dispatchers.Default) {
                runCatching { context.app.queue.addFile("photo", "image/jpeg", Photos.shrink(context, photoUri), note.trim()) }
            }
            kept.onSuccess { photoFile.delete(); onDone("Photo saved to your Shelf") }
                .onFailure { problem = "Satchel could not keep that photo. Try again." }
        }
    }
    LaunchedEffect(Unit) { if (mode == "photo" && !cameraOpened) { cameraOpened = true; camera.launch(photoUri) } }

    Box(Modifier.fillMaxSize().background(Ink.copy(alpha = 0.45f))
        .clickable(remember { MutableInteractionSource() }, null) { onCancel() }) {
        if (mode == "photo") return@Box
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .background(Paper, RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp))
                .clickable(remember { MutableInteractionSource() }, null) {}
                .navigationBarsPadding().imePadding().padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("PUT ON YOUR SHELF", color = Muted, fontSize = 11.sp, letterSpacing = 1.5.sp)
            if (mode != "voice") NoteBox(note, autoFocus = mode == "note") { note = it }
            if (mode == "voice" || mode == "pick") Recorder(note, onSaved = onDone, onProblem = { problem = it })
            problem?.let { Text(it, color = Red, fontSize = 14.sp) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onCancel) { Text("Cancel", color = Muted) }
                Spacer(Modifier.weight(1f))
                if (mode == "pick") OutlinedButton(onClick = { camera.launch(photoUri) }) { Text("Photo", color = InkText) }
                if (mode != "voice") Button(
                    onClick = { context.app.queue.addNote(note.trim()); onDone("Saved to your Shelf") },
                    enabled = note.isNotBlank(),
                    colors = ButtonDefaults.buttonColors(containerColor = InkText, contentColor = Paper),
                ) { Text("Save") }
            }
        }
    }
}

@Composable
private fun NoteBox(value: String, autoFocus: Boolean, onChange: (String) -> Unit) {
    val focus = remember { FocusRequester() }
    OutlinedTextField(
        value = value, onValueChange = { onChange(it.take(ShelfTypes.NOTE_LIMIT)) },
        label = { Text("Note") }, minLines = 2, maxLines = 6,
        modifier = Modifier.fillMaxWidth().focusRequester(focus),
    )
    LaunchedEffect(autoFocus) { if (autoFocus) focus.requestFocus() }
}

/** Tap to start and tap to save, or hold to talk and let go to save. */
@Composable
private fun Recorder(note: String, onSaved: (String) -> Unit, onProblem: (String) -> Unit) {
    val context = LocalContext.current
    // The gesture below is set up once; this keeps it reading the note as typed now.
    val currentNote by rememberUpdatedState(note)
    val scope = rememberCoroutineScope()
    var recorder by remember { mutableStateOf<VoiceRecorder?>(null) }
    var seconds by remember { mutableIntStateOf(0) }
    var allowed by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = it
        if (!it) onProblem("Satchel needs the microphone for voice notes. Allow it in Settings, then try again.") }
    DisposableEffect(Unit) { onDispose { recorder?.discard() } }
    LaunchedEffect(recorder) { seconds = 0; while (recorder != null) { delay(1000); seconds++ } }

    fun start() = runCatching { recorder = VoiceRecorder(context).also { it.start() } }
        .onFailure { onProblem("The microphone is busy. Try again in a moment.") }
    fun save() {
        val r = recorder ?: return
        recorder = null
        scope.launch {
            val kept = withContext(Dispatchers.IO) {
                val bytes = r.stop() ?: return@withContext null
                runCatching { context.app.queue.addFile("voice", "audio/mp4", bytes, currentNote.trim()) }
            }
            when {
                kept == null -> onProblem("That was too short to keep. Hold a little longer.")
                kept.isSuccess -> onSaved("Voice note saved to your Shelf")
                else -> onProblem("Satchel could not keep that voice note.")
            }
        }
    }

    val recording = recorder != null
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(
            Modifier.size(96.dp).background(if (recording) Red else Orange, CircleShape)
                .semantics { contentDescription = if (recording) "Stop and save the voice note" else "Record a voice note" }
                .pointerInput(allowed) {
                    detectTapGestures(onPress = {
                        if (!allowed) { ask.launch(Manifest.permission.RECORD_AUDIO); return@detectTapGestures }
                        val wasRecording = recorder != null
                        if (!wasRecording) start()
                        val pressedAt = System.currentTimeMillis()
                        tryAwaitRelease()
                        // A hold saves on release; a quick tap keeps recording until the next tap.
                        if (wasRecording || System.currentTimeMillis() - pressedAt > 500) save()
                    })
                },
            contentAlignment = Alignment.Center,
        ) { Text(if (recording) "■" else "●", color = Paper, fontSize = 34.sp, fontWeight = FontWeight.Bold) }
        Text(
            if (recording) "Recording ${seconds / 60}:${"%02d".format(seconds % 60)} · tap or let go to save"
            else "Tap to record, or hold to talk",
            color = Muted, fontSize = 14.sp,
        )
    }
}

/** AAC in an M4A file: small, and a type the Shelf and the model both read. */
private class VoiceRecorder(private val context: Context) {
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
