package com.mmail.app

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader

/**
 * Mmail 安卓外壳 / Android shell
 * ---------------------------------------------------------------------------
 * 只做三件事：
 *   1. 用 WebViewAssetLoader 把 web/ 目录挂到 https://appassets.androidplatform.net/assets/
 *      （比 file:// 更安全，也给 localStorage 一个稳定的 origin）
 *   2. 拦截站外链接，交给系统浏览器打开登录页
 *   3. 返回键优先在页面内后退
 *
 * 收件提醒（后台 IMAP + 通知）属于原生能力，见 android/README.md 的规划。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                cacheMode = WebSettings.LOAD_DEFAULT
                allowFileAccess = false
                allowContentAccess = false
                mediaPlaybackRequiresUserGesture = true
                // Provider links use target=_blank. Without this, WebView drops them
                // and shouldOverrideUrlLoading never runs.
                javaScriptCanOpenWindowsAutomatically = true
                setSupportMultipleWindows(true)
            }
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean {
                    val url = request.url
                    if (url.host == APP_HOST) return false
                    openExternal(url)
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onCreateWindow(
                    view: WebView,
                    isDialog: Boolean,
                    isUserGesture: Boolean,
                    resultMsg: Message
                ): Boolean {
                    if (!isUserGesture) return false
                    val extra = view.hitTestResult?.extra
                    if (!extra.isNullOrEmpty()) {
                        val uri = Uri.parse(extra)
                        if (uri.host == APP_HOST) {
                            view.loadUrl(uri.toString())
                        } else {
                            openExternal(uri)
                        }
                        return false
                    }
                    val popup = WebView(view.context)
                    popup.settings.javaScriptEnabled = false
                    popup.settings.allowFileAccess = false
                    popup.webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(
                            popupView: WebView,
                            request: WebResourceRequest
                        ): Boolean {
                            val url = request.url
                            if (url.host == APP_HOST) view.loadUrl(url.toString()) else openExternal(url)
                            popupView.destroy()
                            return true
                        }
                    }
                    val transport = resultMsg.obj as? WebView.WebViewTransport
                    if (transport == null) {
                        popup.destroy()
                        return false
                    }
                    transport.webView = popup
                    resultMsg.sendToTarget()
                    return true
                }
            }
        }

        setContentView(webView)
        webView.loadUrl(START_URL)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private fun openExternal(uri: Uri) {
        val scheme = uri.scheme?.lowercase() ?: return
        if (scheme != "http" && scheme != "https") return
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
    }

    private companion object {
        const val APP_HOST = "appassets.androidplatform.net"
        const val START_URL = "https://appassets.androidplatform.net/assets/index.html"
    }
}
