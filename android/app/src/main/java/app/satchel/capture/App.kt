package app.satchel.capture

import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import okhttp3.OkHttpClient
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.TimeUnit

class App : Application() {
    val http by lazy {
        // Under the Shelf endpoint's 60 second limit, so the phone never gives up on a read the server is still doing.
        OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(55, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS).build()
    }
    val auth by lazy { Auth(this, http) }
    val reader by lazy { ShelfReader(http) { auth.accessToken() } }
    val queue by lazy { Queue(File(filesDir, "queue")) }
    val sender by lazy {
        Sender(queue, ShelfApi(http, BuildConfig.SUPABASE_URL, BuildConfig.SUPABASE_KEY, BuildConfig.SATCHEL_URL) {
            auth.accessToken()
        }) { auth.userId }
    }
}

val Context.app get() = applicationContext as App

/** Starts (or lines up) a send. Runs only with a connection, and backs off between tries. */
private const val SEND_WORK = "send"

fun Context.sendSoon() {
    val manager = WorkManager.getInstance(this)
    val work = OneTimeWorkRequestBuilder<SendWork>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .build()
    // A run waiting out its backoff is replaced, so a new capture never sits
    // behind it for hours. A run that is sending is left alone: cutting it
    // would restart an upload, and it picks up new captures before it ends.
    // Decided once WorkManager has answered, so the screen never waits on its database.
    val decide = manager.getWorkInfosForUniqueWork(SEND_WORK)
    decide.addListener({
        val sending = runCatching { decide.get().any { it.state == WorkInfo.State.RUNNING } }.getOrDefault(false)
        manager.enqueueUniqueWork(SEND_WORK, if (sending) ExistingWorkPolicy.KEEP else ExistingWorkPolicy.REPLACE, work)
    }, androidx.core.content.ContextCompat.getMainExecutor(this))
}

fun Context.stopSending() { WorkManager.getInstance(this).cancelUniqueWork(SEND_WORK) }

class SendWork(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext.app
        if (!app.auth.signedIn) return Result.success()
        return try { if (app.sender.run()) Result.success() else Result.retry() }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: Exception) { Result.retry() }
    }
}

/** Photos are shrunk and fixed as JPEG before they are queued, so a 50 MP photo fits and its size never changes. */
object Photos {
    private const val LONGEST = 2048
    fun shrink(context: Context, uri: Uri): ByteArray {
        // ImageDecoder turns the photo upright from its EXIF data on its own.
        val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, info, _ ->
            val (w, h) = info.size.width to info.size.height
            val scale = minOf(1f, LONGEST.toFloat() / maxOf(w, h))
            decoder.setTargetSize((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1))
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        return ByteArrayOutputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out)
            out.toByteArray()
        }
    }
}
