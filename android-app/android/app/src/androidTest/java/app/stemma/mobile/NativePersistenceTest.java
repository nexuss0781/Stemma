package app.stemma.mobile;

import static org.junit.Assert.*;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import android.webkit.CookieManager;
import android.webkit.WebView;
import java.io.File;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NativePersistenceTest {
    private ActivityScenario<MainActivity> scenario;
    private Object evaluate(String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        scenario.onActivity(activity -> {
            WebView web = activity.getBridge().getWebView();
            web.evaluateJavascript(script, value -> {result.set(value);done.countDown();});
        });
        assertTrue("WebView evaluation completed",done.await(30,TimeUnit.SECONDS));
        return new JSONTokener(result.get()).nextValue();
    }
    private void waitFor(String expression) throws Exception {
        long end=System.currentTimeMillis()+180000;
        while(System.currentTimeMillis()<end){
            if(Boolean.TRUE.equals(evaluate("Boolean("+expression+")"))) return;
            Thread.sleep(1000);
        }
        fail("Timed out: "+expression);
    }
    private void runPromise(String expression) throws Exception {
        evaluate("window.__persistenceTestDone=false;window.__persistenceTestError='';Promise.resolve("+expression+").then(()=>window.__persistenceTestDone=true).catch(e=>{window.__persistenceTestError=String(e);window.__persistenceTestDone=true;});true");
        waitFor("window.__persistenceTestDone");
        assertEquals("",evaluate("window.__persistenceTestError"));
    }
    private void deleteCache(File directory) {
        File[] files=directory.listFiles();
        if(files!=null)for(File file:files){if(file.isDirectory())deleteCache(file);file.delete();}
    }
    @Test public void durableStorageSurvivesCacheClearAndActivityRecreation() throws Exception {
        scenario=ActivityScenario.launch(MainActivity.class);
        try {
            waitFor("window.StemmaNative && window.StemmaNative.persistence");
            runPromise("window.StemmaNative.persistence.set('instrumentation-durable','private-state-102')");
            deleteCache(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir());
            runPromise("window.StemmaNative.persistence.get('instrumentation-durable').then(v=>{if(v!=='private-state-102')throw Error('Cache clear removed durable data');})");
            scenario.recreate();
            waitFor("window.StemmaNative && window.StemmaNative.persistence");
            runPromise("window.StemmaNative.persistence.get('instrumentation-durable').then(v=>{if(v!=='private-state-102')throw Error('Activity recreation lost durable data');})");
            runPromise("window.StemmaNative.persistence.remove('instrumentation-durable')");
            runPromise("window.StemmaNative.persistence.get('instrumentation-durable').then(v=>{if(v!==null)throw Error('Private key not removed');})");
        } finally {scenario.close();}
    }
    @Test public void persistentCookiesSurviveActivityRecreation() throws Exception {
        scenario=ActivityScenario.launch(MainActivity.class);
        try {
            waitFor("window.StemmaNative && window.StemmaNative.persistence");
            CountDownLatch set=new CountDownLatch(1);
            scenario.onActivity(activity->CookieManager.getInstance().setCookie("https://localhost", "stemma_persistence_test=102; Max-Age=3600; Path=/; Secure; HttpOnly",ok->set.countDown()));
            assertTrue(set.await(30,TimeUnit.SECONDS));
            runPromise("window.StemmaNative.persistence.flush()");
            scenario.recreate();
            waitFor("window.StemmaNative && window.StemmaNative.persistence");
            String cookies=CookieManager.getInstance().getCookie("https://localhost");
            assertNotNull(cookies);assertTrue(cookies.contains("stemma_persistence_test=102"));
            CountDownLatch removed=new CountDownLatch(1);
            scenario.onActivity(activity->CookieManager.getInstance().setCookie("https://localhost", "stemma_persistence_test=; Max-Age=0; Path=/; Secure; HttpOnly",ok->removed.countDown()));
            assertTrue(removed.await(30,TimeUnit.SECONDS));
            runPromise("window.StemmaNative.persistence.flush()");
        } finally {scenario.close();}
    }
}
