package app.satchel.capture

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.service.quicksettings.TileService
import android.widget.RemoteViews

/** Home screen widget: Photo, Voice and Note, each one tap into the capture sheet. */
class CaptureWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val views = RemoteViews(context.packageName, R.layout.widget_capture).apply {
            setOnClickPendingIntent(R.id.widget_photo, open(context, "photo", 1))
            setOnClickPendingIntent(R.id.widget_voice, open(context, "voice", 2))
            setOnClickPendingIntent(R.id.widget_note, open(context, "note", 3))
        }
        manager.updateAppWidget(ids, views)
    }
}

private fun open(context: Context, mode: String, request: Int) = PendingIntent.getActivity(
    context, request, CaptureActivity.intent(context, mode),
    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
)

/** Quick Settings tile: opens capture on the camera, from any screen, locked or not. */
class CaptureTile : TileService() {
    override fun onClick() {
        super.onClick()
        // Capture opens over the lock screen, like the camera: no unlock needed to put something on the Shelf.
        startActivityAndCollapse(open(this, "camera", 4))
    }
}
