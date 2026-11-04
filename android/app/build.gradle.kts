plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The project URL and publishable key are public (the web app ships them too),
// but they live in the repo's .env, not in git. CI passes them as variables.
fun satchelSetting(name: String): String {
    System.getenv(name)?.takeIf { it.isNotBlank() }?.let { return it }
    val env = rootProject.file("../.env")
    if (env.exists()) env.readLines().firstOrNull { it.startsWith("$name=") }
        ?.let { return it.substringAfter("=").trim().trim('"') }
    return ""
}

// One release key for the life of the app: a changed key cannot update an
// installed copy, and reinstalling wipes the sign-in and anything unsent.
val releaseKey = System.getenv("SATCHEL_ANDROID_KEYSTORE")?.let { file(it) }?.takeIf { it.exists() }

android {
    namespace = "app.satchel.capture"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.satchel.capture"
        minSdk = 34
        targetSdk = 37
        versionCode = 5
        versionName = "0.2.0"
        buildConfigField("String", "SUPABASE_URL", "\"${satchelSetting("VITE_SUPABASE_URL")}\"")
        buildConfigField("String", "SUPABASE_KEY", "\"${satchelSetting("VITE_SUPABASE_PUBLISHABLE_KEY")}\"")
        buildConfigField("String", "SATCHEL_URL", "\"https://satchel-pi.vercel.app\"")
    }

    signingConfigs {
        if (releaseKey != null) create("release") {
            storeFile = releaseKey
            storePassword = System.getenv("SATCHEL_ANDROID_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("SATCHEL_ANDROID_KEY_ALIAS") ?: "satchel"
            keyPassword = System.getenv("SATCHEL_ANDROID_KEY_PASSWORD") ?: System.getenv("SATCHEL_ANDROID_KEYSTORE_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            if (releaseKey != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    implementation("androidx.browser:browser:1.10.0")
    implementation("androidx.camera:camera-camera2:1.6.2")
    implementation("androidx.camera:camera-lifecycle:1.6.2")
    implementation("androidx.camera:camera-compose:1.6.2")
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver3:5.5.1")
    testImplementation("org.json:json:20250517")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
}
