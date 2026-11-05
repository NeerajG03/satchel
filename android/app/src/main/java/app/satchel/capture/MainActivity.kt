package app.satchel.capture

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/** Sign-in, then the Shelf: what waits for a yes, the week ahead, everything dropped, and the key that opens capture. */
class MainActivity : ComponentActivity() {
    private var signedIn by mutableStateOf(false)
    private var message by mutableStateOf<String?>(null)
    private var waiting by mutableStateOf(listOf<QueuedItem>())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val fromHistory = intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (savedInstanceState == null && !fromHistory) handle(intent)
        setContent { SatchelTheme { Home() } }
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); handle(intent) }

    override fun onResume() {
        super.onResume()
        refresh()
        // Opening the app is also a chance to send anything a strict battery saver held back.
        if (signedIn) sendSoon()
    }

    private fun refresh() { signedIn = app.auth.signedIn; waiting = app.queue.pending() }

    /** A sign-in code works once, so the link is cleared as soon as it is read. */
    private fun handle(intent: Intent?) {
        val data = intent?.data ?: return
        if (!data.toString().startsWith(REDIRECT)) return
        intent.data = null
        setIntent(intent)
        val code = data.getQueryParameter("code")
        if (code == null) {
            message = data.getQueryParameter("error_description") ?: "Sign-in did not finish. Try again."
            return
        }
        message = "Signing you in…"
        lifecycleScope.launch {
            message = app.auth.finishSignIn(code)
            refresh()
            if (signedIn) sendSoon()
        }
    }

    @Composable
    private fun Home() {
        if (signedIn) {
            val stuck = waiting.filter { it.problem != null }
            ShelfScreen(app.reader, unsent = waiting.size - stuck.size, stuck = stuck,
                onClearStuck = { stuck.forEach(app.queue::remove); refresh() },
                onCapture = { startActivity(CaptureActivity.intent(this, it)) },
                onSignOut = {
                    stopSending(); app.queue.clear()
                    lifecycleScope.launch { app.auth.signOutEverywhere() }
                    refresh(); signedIn = false
                })
            return
        }
        // Signed out: the frame and the wordmark, then one sheet of paper with the way in.
        Column(Modifier.fillMaxSize().background(Hw).statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Text("satchel", fontFamily = Mark, fontSize = 32.sp, color = HwText, modifier = Modifier.weight(1f))
                Led(LedOff, "signed out")
            }
            Column(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 8.dp).background(Paper, androidx.compose.foundation.shape.RoundedCornerShape(14.dp))
                .padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("Drop it here, find it later.", style = Type.page, color = InkText)
                Text("Sign in with the account you use for Satchel. Your Shelf stays yours: only you can see it.", style = Type.body, color = Muted)
                message?.let { Text(it, style = Type.fine, color = if (it.endsWith("…")) Muted else Red) }
            }
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                HardwareKey("Continue with Google", { app.auth.startSignIn(this@MainActivity, "google") }, Modifier.fillMaxWidth(), height = 56.dp, light = Orange)
                HardwareKey("Use GitHub instead", { app.auth.startSignIn(this@MainActivity, "github") }, Modifier.fillMaxWidth())
            }
        }
    }
}
