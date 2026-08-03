package com.laemthong.displaytv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private static final String PREFS_NAME = "display_tv";
    private static final String KEY_SCREEN = "screen";
    private static final int TOTAL_SCREENS = 2;
    private static final long RETRY_DELAY_MS = 10000L;
    private static final long PERIODIC_REFRESH_MS = 30L * 60L * 1000L;
    private static final long WATCHDOG_INTERVAL_MS = 60L * 1000L;
    private static final long STUCK_LOAD_MS = 2L * 60L * 1000L;
    private static final long STALE_PAGE_MS = 45L * 60L * 1000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private TextView statusView;
    private int screen;
    private long lastLoadStartedAt = 0L;
    private long lastPageFinishedAt = 0L;

    private final Runnable retryLoad = new Runnable() {
        @Override
        public void run() {
            loadDisplay();
        }
    };

    private final Runnable periodicRefresh = new Runnable() {
        @Override
        public void run() {
            loadDisplay();
            schedulePeriodicRefresh();
        }
    };

    private final Runnable watchdogCheck = new Runnable() {
        @Override
        public void run() {
            checkDisplayHealth();
            handler.postDelayed(this, WATCHDOG_INTERVAL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureWindow();
        screen = readScreen();
        buildUi();
        loadDisplay();
        schedulePeriodicRefresh();
        handler.postDelayed(watchdogCheck, WATCHDOG_INTERVAL_MS);
    }

    @Override
    protected void onResume() {
        super.onResume();
        enterImmersiveMode();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() != KeyEvent.ACTION_UP) return super.dispatchKeyEvent(event);

        int keyCode = event.getKeyCode();
        if (keyCode == KeyEvent.KEYCODE_1 || keyCode == KeyEvent.KEYCODE_NUMPAD_1 || keyCode == KeyEvent.KEYCODE_DPAD_LEFT) {
            setScreen(1);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_2 || keyCode == KeyEvent.KEYCODE_NUMPAD_2 || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) {
            setScreen(2);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_REFRESH || keyCode == KeyEvent.KEYCODE_R) {
            loadDisplay();
            return true;
        }

        return super.dispatchKeyEvent(event);
    }

    private void configureWindow() {
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
            WindowManager.LayoutParams.FLAG_FULLSCREEN | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        );
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                lastLoadStartedAt = System.currentTimeMillis();
                enterImmersiveMode();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                lastPageFinishedAt = System.currentTimeMillis();
                showStatus("");
                enterImmersiveMode();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request == null || request.isForMainFrame()) scheduleRetry("กำลังเชื่อมต่อใหม่");
            }
        });

        statusView = new TextView(this);
        statusView.setGravity(Gravity.CENTER);
        statusView.setTextColor(Color.WHITE);
        statusView.setTextSize(24);
        statusView.setBackgroundColor(0xDD0A2418);
        statusView.setVisibility(View.GONE);

        root.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        root.addView(statusView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));

        setContentView(root);
    }

    private int readScreen() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        int saved = prefs.getInt(KEY_SCREEN, BuildConfig.DEFAULT_SCREEN);
        return saved == 2 ? 2 : 1;
    }

    private void setScreen(int nextScreen) {
        screen = nextScreen == 2 ? 2 : 1;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit()
            .putInt(KEY_SCREEN, screen)
            .apply();
        loadDisplay();
    }

    private void loadDisplay() {
        handler.removeCallbacks(retryLoad);
        if (!isOnline()) {
            scheduleRetry("รออินเทอร์เน็ต");
            return;
        }

        lastLoadStartedAt = System.currentTimeMillis();
        showStatus("กำลังเปิดจอ " + screen);
        webView.loadUrl(buildDisplayUrl());
    }

    private String buildDisplayUrl() {
        return BuildConfig.DISPLAY_BASE_URL
            + "?wallMode=wall"
            + "&screens=" + TOTAL_SCREENS
            + "&screen=" + screen
            + "&_fresh=" + BuildConfig.DISPLAY_VERSION
            + "&_ts=" + System.currentTimeMillis();
    }

    private boolean isOnline() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return true;
        Network network = cm.getActiveNetwork();
        if (network == null) return false;
        NetworkCapabilities caps = cm.getNetworkCapabilities(network);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void scheduleRetry(String message) {
        showStatus(message + "\nจอ " + screen + " จะลองใหม่อัตโนมัติ");
        handler.removeCallbacks(retryLoad);
        handler.postDelayed(retryLoad, RETRY_DELAY_MS);
    }

    private void schedulePeriodicRefresh() {
        handler.removeCallbacks(periodicRefresh);
        handler.postDelayed(periodicRefresh, PERIODIC_REFRESH_MS);
    }

    private void checkDisplayHealth() {
        if (webView == null) return;

        if (!isOnline()) {
            scheduleRetry("รออินเทอร์เน็ต");
            return;
        }

        long now = System.currentTimeMillis();
        boolean loadingTooLong = lastLoadStartedAt > lastPageFinishedAt
            && now - lastLoadStartedAt > STUCK_LOAD_MS;
        boolean pageTooOld = lastPageFinishedAt > 0L
            && now - lastPageFinishedAt > STALE_PAGE_MS;
        boolean pageLooksEmpty = webView.getProgress() >= 100
            && lastPageFinishedAt > 0L
            && webView.getTitle() == null;

        if (loadingTooLong || pageTooOld || pageLooksEmpty) {
            loadDisplay();
        }
    }

    private void showStatus(String message) {
        if (message == null || message.isEmpty()) {
            statusView.setVisibility(View.GONE);
            return;
        }
        statusView.setText(message);
        statusView.setVisibility(View.VISIBLE);
    }

    private void enterImmersiveMode() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }
}
