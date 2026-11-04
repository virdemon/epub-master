package com.epubmaster.app;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DownloadSaverPlugin.class);
        super.onCreate(savedInstanceState);

        // 系统返回键交给网页处理：网页能回上一页就回，回不去才退出应用
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() == null || getBridge().getWebView() == null) {
                    finish();
                    return;
                }
                getBridge().getWebView().evaluateJavascript(
                        "(function(){try{return window.__emBack ? window.__emBack() : false}catch(e){return false}})()",
                        value -> {
                            if (!"true".equals(value)) {
                                finish();
                            }
                        });
            }
        });
    }
}
