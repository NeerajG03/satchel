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
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import okhttp3.OkHttpClient
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.TimeUnit

class App : Application() {
    val http by lazy {
        OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(75, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS).build()
    }
    val auth by lazy { Auth(this, http) }
    val queue by lazy { Queue(File(filesDir, "queue")) }
    val sender by lazy {
        Sender(queue, ShelfApi(http, BuildConfig.SUPABASE_URL, BuildConfig.SUPABASE_KEY, BuildConfig.SATCHEL_URL) {
            auth.accessToken()
        }) { auth.userId }
    }
}

val Context.app get() = applicationContext as App

/** Starts (or lines up) a send. Runs only with a connection, and backs off between tries. */
fun Context.sendSoon() {
    val work = OneTimeWorkRequestBuilder<SendWork>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .build()
    WorkManager.getInstance(this).enqueueUniqueWork("send", ExistingWorkPolicy.APPEND_OR_REPLACE, work)
}

class SendWork(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext.app
        if (!app.auth.signedIn) return Result.success()
        return if (app.sender.run()) Result.success() else Result.retry()
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
