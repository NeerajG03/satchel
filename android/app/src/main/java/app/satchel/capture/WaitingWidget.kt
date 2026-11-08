package app.satchel.capture

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit

/**
 * Waiting for you, on the home screen: the next to-do or event Satchel found in
 * what was dropped, with Add and Skip, so saying yes never needs the app. It
 * keeps Satchel's shape (a strip with a light and its word, the count in
 * figures) in the wallpaper's own colours, like the Capture widget, so it sits
 * with themed icons. What it shows is kept on the phone and refreshed when the
 * app opens, after Add or Skip, and every half hour.
 */
object WaitingWidget {
    private const val PREFS = "waiting-widget"
    private const val WORK = "waiting-widget"
    const val ACTION_ADD = "app.satchel.capture.WAITING_ADD"
    const val ACTION_SKIP = "app.satchel.capture.WAITING_SKIP"

    /** Asks for a fresh read in the background; the widget redraws when it lands. */
    fun refresh(context: Context) {
        val ids = ids(context)
        if (ids.isEmpty()) return
        WorkManager.getInstance(context).enqueueUniqueWork(WORK, ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<WaitingWork>().build())
    }

    fun schedule(context: Context) {
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("$WORK-periodic", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<WaitingWork>(30, TimeUnit.MINUTES).build())
    }

    fun unschedule(context: Context) { WorkManager.getInstance(context).cancelUniqueWork("$WORK-periodic") }

    fun ids(context: Context): IntArray =
        AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, WaitingWidgetProvider::class.java))

    /** Keeps what was read, so a redraw never needs the network. */
    fun store(context: Context, waiting: List<Waiting>, linked: List<String>) {
        val rows = JSONArray(waiting.map {
            JSONObject().put("id", it.id).put("kind", it.kind).put("title", it.title).put("profile", it.profile ?: JSONObject.NULL)
                .put("when", it.when_ ?: JSONObject.NULL).put("source", it.source)
        })
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("waiting", rows.toString()).putString("linked", JSONArray(linked).toString()).apply()
    }

    private fun stored(context: Context): Pair<List<Waiting>, List<String>> {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val rows = runCatching { JSONArray(prefs.getString("waiting", "[]")) }.getOrDefault(JSONArray())
        val list = (0 until rows.length()).map { i ->
            val o = rows.getJSONObject(i)
            fun str(k: String) = if (o.isNull(k)) null else o.optString(k)
            Waiting(o.getString("id"), o.getString("kind"), o.getString("title"), str("profile"), str("when"), o.optString("source"))
        }
        val linked = runCatching { JSONArray(prefs.getString("linked", "[]")) }.getOrDefault(JSONArray())
        return list to (0 until linked.length()).map { linked.getString(it) }
    }

    fun drop(context: Context, id: String) {
        val (list, linked) = stored(context)
        store(context, list.filterNot { it.id == id }, linked)
        draw(context)
    }

    fun draw(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        val (list, linked) = stored(context)
        val signedIn = context.app.auth.signedIn
        for (id in ids(context)) manager.updateAppWidget(id, RemoteViews(mapOf(
            SizeF(110f, 110f) to views(context, R.layout.widget_waiting_small, list, linked, signedIn, wide = false),
            SizeF(250f, 110f) to views(context, R.layout.widget_waiting, list, linked, signedIn, wide = true),
        )))
    }

    private fun views(context: Context, layout: Int, list: List<Waiting>, linked: List<String>, signedIn: Boolean, wide: Boolean) =
        RemoteViews(context.packageName, layout).apply {
            val open = PendingIntent.getActivity(context, 20, Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            setOnClickPendingIntent(R.id.waiting_root, open)
            val next = list.firstOrNull()
            // Green only when it is true: signed in, read, and nothing waiting.
            setImageViewResource(R.id.waiting_light, if (next == null && signedIn) R.drawable.led_green else R.drawable.led_amber)
            setTextViewText(R.id.waiting_count, if (signedIn) list.size.toString() else "–")
            setTextViewText(R.id.waiting_word, when {
                !signedIn -> "SIGN IN"
                next == null -> "ALL SORTED"
                wide -> "WAITING FOR YOU"
                else -> "WAITING"
            })
            setTextViewText(R.id.waiting_title, when {
                !signedIn -> "Open Satchel to sign in."
                next == null -> "Nothing waiting. New to-dos from your drops show here."
                else -> next.title
            })
            if (!wide) return@apply
            setViewVisibility(R.id.waiting_keys, if (next != null && signedIn) View.VISIBLE else View.GONE)
            setTextViewText(R.id.waiting_line, if (next == null) "" else listOfNotNull(
                if (next.kind == "todo") "TO-DO" else "EVENT", next.profile?.uppercase(), next.when_?.let(::whenLine)).joinToString(" · "))
            if (next == null) return@apply
            val where = next.profile
            if (where != null && where in linked) {
                setTextViewText(R.id.waiting_add, if (next.kind == "todo") "Add to To-dos" else "Add to Calendar")
                setOnClickPendingIntent(R.id.waiting_add, action(context, ACTION_ADD, next.id, where, 21))
            } else {
                // No profile yet, or that slot goes nowhere: the app asks which, or says to set one.
                setTextViewText(R.id.waiting_add, "Open to add")
                setOnClickPendingIntent(R.id.waiting_add, open)
            }
            setOnClickPendingIntent(R.id.waiting_skip, action(context, ACTION_SKIP, next.id, where, 22))
        }

    private fun action(context: Context, what: String, id: String, profile: String?, code: Int) = PendingIntent.getBroadcast(
        context, code, Intent(context, WaitingActions::class.java).setAction(what).putExtra("id", id).putExtra("profile", profile),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    private fun whenLine(value: String): String? = runCatching {
        val day = if (value.length == 10) LocalDate.parse(value)
            else OffsetDateTime.parse(value).atZoneSameInstant(java.time.ZoneId.systemDefault()).toLocalDate()
        when (day) {
            LocalDate.now() -> "TODAY"
            LocalDate.now().plusDays(1) -> "TOMORROW"
            else -> day.format(DateTimeFormatter.ofPattern("EEE d MMM")).uppercase()
        }
    }.getOrNull()
}

class WaitingWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        WaitingWidget.draw(context)
        WaitingWidget.refresh(context)
    }
    override fun onEnabled(context: Context) = WaitingWidget.schedule(context)
    override fun onDisabled(context: Context) = WaitingWidget.unschedule(context)
}

/** Reads what is waiting, and which profiles have Google linked, as the person. */
class WaitingWork(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext.app
        if (!app.auth.signedIn) { WaitingWidget.draw(applicationContext); return Result.success() }
        return runCatching {
            val waiting = app.reader.waiting()
            val linked = runCatching { app.reader.linkedProfiles() }.getOrDefault(emptyList())
            WaitingWidget.store(applicationContext, waiting, linked)
            WaitingWidget.draw(applicationContext)
        }.fold({ Result.success() }, { Result.retry() })
    }
}

/** Add and Skip from the widget: done as the person, then the next one moves up. */
class WaitingActions : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra("id") ?: return
        val profile = intent.getStringExtra("profile")
        val add = intent.action == WaitingWidget.ACTION_ADD
        // Off the screen at once, so a second tap cannot land on the same one.
        WaitingWidget.drop(context, id)
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val reader = context.app.reader
                runCatching { if (add && profile != null) reader.addToGoogle(id, profile) else reader.dismiss(id) }
            } finally {
                WaitingWidget.refresh(context)
                pending.finish()
            }
        }
    }
}
