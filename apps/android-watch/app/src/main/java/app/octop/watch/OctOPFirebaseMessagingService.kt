package app.octop.watch

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.time.OffsetDateTime

class OctOPFirebaseMessagingService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    super.onNewToken(token)
    getSharedPreferences("octop.watch.runtime", Context.MODE_PRIVATE)
      .edit()
      .putString("lastToken", token)
      .apply()
  }

  override fun onMessageReceived(message: RemoteMessage) {
    super.onMessageReceived(message)
    val title = message.notification?.title ?: message.data["title"] ?: "OctOP"
    val body = message.notification?.body ?: message.data["body"] ?: "새 알림"
    val launchUrl = message.data["launchUrl"] ?: "/"
    RecentNotificationStore(this).append(
      RecentNotification(
        title = title,
        body = body,
        receivedAt = OffsetDateTime.now().toString(),
        launchUrl = launchUrl
      )
    )
    showNotification(title, body, launchUrl)
  }

  private fun showNotification(title: String, body: String, launchUrl: String) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel("octop_alerts", "OctOP Alerts", NotificationManager.IMPORTANCE_HIGH)
      )
    }

    val intent = Intent(this, MainActivity::class.java)
      .putExtra("launchUrl", launchUrl)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val pendingIntent = PendingIntent.getActivity(
      this,
      1001,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val notification = NotificationCompat.Builder(this, "octop_alerts")
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setContentIntent(pendingIntent)
      .setAutoCancel(true)
      .build()

    manager.notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notification)
  }
}
