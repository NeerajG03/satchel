package app.satchel.capture

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.util.SizeF
import android.service.quicksettings.TileService
import android.widget.RemoteViews

/**
 * Home screen widget: one key. The whole widget opens capture on the camera,
 * where a tap takes a photo, a hold talks, and Type writes. One cell shows just
 * the key; wider shows its name too.
 */
class CaptureWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val tap = open(context, "camera", 1)
        fun layout(id: Int) = RemoteViews(context.packageName, id).apply { setOnClickPendingIntent(R.id.widget_drop, tap) }
        val views = RemoteViews(mapOf(SizeF(40f, 40f) to layout(R.layout.widget_capture_small),
            SizeF(140f, 40f) to layout(R.layout.widget_capture)))
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
