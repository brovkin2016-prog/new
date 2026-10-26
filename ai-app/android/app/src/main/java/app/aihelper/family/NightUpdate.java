package app.aihelper.family;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * (v36) The app's own update at night: about every hour (while there is a network) Updater.night looks whether a newer
 * version is on the server, fetches and checks it, and puts it in between 1 and 6 o'clock with the screen off.
 */
public final class NightUpdate extends JobService {
    private static final int JOB = 43;

    static void schedule(Context c) {
        JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (js == null || js.getPendingJob(JOB) != null) return;
        js.schedule(new JobInfo.Builder(JOB, new ComponentName(c, NightUpdate.class))
                .setPeriodic(60 * 60 * 1000L)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build());
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            try {
                Updater.night(this);
            } catch (Exception ignored) {
                // the next hour again
            }
            jobFinished(params, false);
        }, "night-update").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }
}
