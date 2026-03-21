package app.octop.watch

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
  private val executor = Executors.newSingleThreadExecutor()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_main)
    requestNotificationPermissionIfNeeded()

    val preferences = WatchPreferences(this)
    val notificationStore = RecentNotificationStore(this)
    val settings = preferences.read()

    val gatewayUrlInput: EditText = findViewById(R.id.gatewayUrlInput)
    val loginIdInput: EditText = findViewById(R.id.loginIdInput)
    val bridgeIdInput: EditText = findViewById(R.id.bridgeIdInput)
    val statusText: TextView = findViewById(R.id.statusText)
    val tokenText: TextView = findViewById(R.id.tokenText)
    val recentNotificationsText: TextView = findViewById(R.id.recentNotificationsText)
    val saveButton: Button = findViewById(R.id.saveButton)
    val registerButton: Button = findViewById(R.id.registerButton)

    gatewayUrlInput.setText(settings.gatewayUrl)
    loginIdInput.setText(settings.loginId)
    bridgeIdInput.setText(settings.bridgeId)
    renderNotifications(recentNotificationsText, notificationStore)

    val launchUrl = intent.getStringExtra("launchUrl")
    if (!launchUrl.isNullOrBlank()) {
      statusText.text = "알림 진입: $launchUrl"
    }

    val cachedToken = getSharedPreferences("octop.watch.runtime", MODE_PRIVATE)
      .getString("lastToken", "")
      .orEmpty()
    tokenText.text = if (cachedToken.isBlank()) getString(R.string.token_placeholder) else cachedToken

    saveButton.setOnClickListener {
      val next = WatchSettings(
        gatewayUrl = gatewayUrlInput.text.toString().trim(),
        loginId = loginIdInput.text.toString().trim(),
        bridgeId = bridgeIdInput.text.toString().trim()
      )
      preferences.save(next)
      statusText.text = "설정을 저장했습니다."
    }

    registerButton.setOnClickListener {
      statusText.text = "워치 푸시 토큰을 확인하는 중입니다."
      if (!FirebaseBootstrap.initialize(this)) {
        statusText.text = "Firebase 설정값이 없습니다. Gradle 환경 변수를 확인해 주세요."
        return@setOnClickListener
      }

      FirebaseMessaging.getInstance().token
        .addOnSuccessListener { token ->
          tokenText.text = token
          getSharedPreferences("octop.watch.runtime", MODE_PRIVATE)
            .edit()
            .putString("lastToken", token)
            .apply()

          executor.execute {
            val saved = WatchSettings(
              gatewayUrl = gatewayUrlInput.text.toString().trim(),
              loginId = loginIdInput.text.toString().trim(),
              bridgeId = bridgeIdInput.text.toString().trim()
            )
            runCatching {
              PushRegistrationClient().register(saved, token)
            }.onSuccess { response ->
              runOnUiThread {
                statusText.text = "등록 완료: $response"
              }
            }.onFailure { error ->
              runOnUiThread {
                statusText.text = error.message ?: "등록 실패"
              }
            }
          }
        }
        .addOnFailureListener { error ->
          statusText.text = error.message ?: "워치 푸시 토큰 조회 실패"
        }
    }
  }

  override fun onResume() {
    super.onResume()
    renderNotifications(findViewById(R.id.recentNotificationsText), RecentNotificationStore(this))
  }

  private fun renderNotifications(target: TextView, store: RecentNotificationStore) {
    val lines = store.read().map { item ->
      "${item.receivedAt}\n${item.title}\n${item.body}\n${item.launchUrl}"
    }
    target.text = if (lines.isEmpty()) getString(R.string.no_recent_notifications) else lines.joinToString("\n\n")
  }

  private fun requestNotificationPermissionIfNeeded() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      return
    }

    if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
      return
    }

    ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
  }
}
