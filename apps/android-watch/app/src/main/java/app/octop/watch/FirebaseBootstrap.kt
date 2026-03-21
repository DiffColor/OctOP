package app.octop.watch

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions

object FirebaseBootstrap {
  fun initialize(context: Context): Boolean {
    if (FirebaseApp.getApps(context).isNotEmpty()) {
      return true
    }

    if (
      BuildConfig.FCM_PROJECT_ID.isBlank() ||
      BuildConfig.FCM_APPLICATION_ID.isBlank() ||
      BuildConfig.FCM_API_KEY.isBlank() ||
      BuildConfig.FCM_GCM_SENDER_ID.isBlank()
    ) {
      return false
    }

    val options = FirebaseOptions.Builder()
      .setProjectId(BuildConfig.FCM_PROJECT_ID)
      .setApplicationId(BuildConfig.FCM_APPLICATION_ID)
      .setApiKey(BuildConfig.FCM_API_KEY)
      .setGcmSenderId(BuildConfig.FCM_GCM_SENDER_ID)
      .build()

    FirebaseApp.initializeApp(context, options)
    return true
  }
}
