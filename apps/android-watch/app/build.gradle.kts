plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

fun stringConfig(name: String, fallback: String = ""): String {
  return (project.findProperty(name) as String?)
    ?: System.getenv(name)
    ?: fallback
}

android {
  namespace = "app.octop.watch"
  compileSdk = 35

  defaultConfig {
    applicationId = "app.octop.watch"
    minSdk = 30
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"

    buildConfigField("String", "FCM_PROJECT_ID", "\"${stringConfig("OCTOP_FIREBASE_PROJECT_ID")}\"")
    buildConfigField("String", "FCM_APPLICATION_ID", "\"${stringConfig("OCTOP_FIREBASE_APPLICATION_ID")}\"")
    buildConfigField("String", "FCM_API_KEY", "\"${stringConfig("OCTOP_FIREBASE_API_KEY")}\"")
    buildConfigField("String", "FCM_GCM_SENDER_ID", "\"${stringConfig("OCTOP_FIREBASE_GCM_SENDER_ID")}\"")
  }

  buildFeatures {
    buildConfig = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.15.0")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("com.google.android.material:material:1.12.0")
  implementation(platform("com.google.firebase:firebase-bom:33.10.0"))
  implementation("com.google.firebase:firebase-messaging-ktx")
  implementation("com.google.firebase:firebase-installations-ktx")
}
