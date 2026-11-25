import React, {useCallback, useEffect, useState} from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  Lock,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  clearLowConfidenceLocalLogs,
  getLowConfidenceLocalLogs,
  type LowConfidenceLogEntry,
} from '../../lib/classifier';
import {
  exportLocalFeedbackJson,
  getLearningConsentState,
  getLocalFeedbackHistory,
  setLearningConsent,
  withdrawConsentAndDeleteData,
} from '../../lib/feedback';
import {
  checkAndUpdateOfflineModel,
  getModelStatusSnapshot,
  getWifiAndChargingOnlyPreference,
  rollbackOfflineModel,
  setWifiAndChargingOnlyPreference,
} from '../../lib/modelUpdater';
import type {
  EmergencyId,
  EmergencyProtocol,
  FeedbackSignalPayload,
  Language,
  ModelStatusSnapshot,
} from '../../src/types/emergency';

interface Props {
  lang: Language;
  protocols: EmergencyProtocol[];
  onBackHome: () => void;
}

interface SupabaseEmergencyEventRow {
  id: string;
  device_id?: string;
  phrase: string;
  language: string;
  matched_intent: string;
  source: string;
  confidence?: number | null;
  approx_lat?: number | null;
  approx_lng?: number | null;
  created_at: string;
}

interface SupabaseFeedbackRow {
  id: string;
  device_id?: string;
  phrase: string;
  matched_intent: string;
  is_correct: boolean;
  corrected_intent?: string | null;
  created_at: string;
}

export const AdminReviewerPage: React.FC<Props> = ({
  lang,
  protocols,
  onBackHome,
}) => {
  const [modelStatus, setModelStatus] = useState<ModelStatusSnapshot>(() =>
    getModelStatusSnapshot()
  );
  const [wifiPref, setWifiPref] = useState<boolean>(
    getWifiAndChargingOnlyPreference
  );
  const [actionMsg, setActionMsg] = useState('');
  const [lowConfLogs, setLowConfLogs] = useState<LowConfidenceLogEntry[]>(() =>
    getLowConfidenceLocalLogs()
  );
  const [localFeedback, setLocalFeedback] = useState<FeedbackSignalPayload[]>(
    () => getLocalFeedbackHistory()
  );
  const [consentState, setConsentState] = useState(getLearningConsentState);

  const [reviewerToken, setReviewerToken] = useState('');
  const [queueItems, setQueueItems] = useState<FeedbackSignalPayload[]>([]);
  const [supabaseEvents, setSupabaseEvents] = useState<
    SupabaseEmergencyEventRow[]
  >([]);
  const [supabaseFeedback, setSupabaseFeedback] = useState<
    SupabaseFeedbackRow[]
  >([]);
  const [supabaseNote, setSupabaseNote] = useState<string>('');
  const [queueError, setQueueError] = useState('');
  const [queueLoading, setQueueLoading] = useState(false);

  const refreshLocal = useCallback(() => {
    setModelStatus(getModelStatusSnapshot());
    setLowConfLogs(getLowConfidenceLocalLogs());
    setLocalFeedback(getLocalFeedbackHistory());
    setConsentState(getLearningConsentState());
  }, []);

  const loadReviewerQueue = useCallback(async () => {
    const token = reviewerToken.trim();
    if (!token) {
      setQueueError('Enter RAKSHAK_ADMIN_TOKEN first.');
      return;
    }
    setQueueLoading(true);
    setQueueError('');
    setSupabaseNote('');
    try {
      const headers = {Authorization: `Bearer ${token}`};
      const [eventsRes, queueRes] = await Promise.all([
        fetch('/api/admin/events', {headers}),
        fetch('/api/learning/queue', {headers}),
      ]);

      const eventsData = (await eventsRes.json().catch(() => ({}))) as {
        emergencyEvents?: SupabaseEmergencyEventRow[];
        feedback?: SupabaseFeedbackRow[];
        localQueue?: FeedbackSignalPayload[];
        supabaseNote?: string | null;
        error?: string;
      };

      const queueData = (await queueRes.json().catch(() => ({}))) as {
        items?: FeedbackSignalPayload[];
        error?: string;
      };

      if (!eventsRes.ok && !queueRes.ok) {
        setQueueError(
          eventsData.error || queueData.error || `HTTP ${eventsRes.status}`
        );
        setQueueItems([]);
        setSupabaseEvents([]);
        setSupabaseFeedback([]);
      } else {
        setQueueItems(eventsData.localQueue || queueData.items || []);
        setSupabaseEvents(
          Array.isArray(eventsData.emergencyEvents)
            ? eventsData.emergencyEvents
            : []
        );
        setSupabaseFeedback(
          Array.isArray(eventsData.feedback) ? eventsData.feedback : []
        );
        if (eventsData.supabaseNote) {
          setSupabaseNote(eventsData.supabaseNote);
        }
      }
    } catch (err) {
      setQueueError(
        err instanceof Error ? err.message : 'Unable to reach reviewer queue.'
      );
    } finally {
      setQueueLoading(false);
    }
  }, [reviewerToken]);

  useEffect(() => {
    refreshLocal();
  }, [refreshLocal]);

  const handleCheckUpdates = async () => {
    setActionMsg(
      lang === 'hi' ? 'अपडेट जाँच रहे हैं...' : 'Checking for signed updates...'
    );
    const res = await checkAndUpdateOfflineModel(true);
    setActionMsg(res.message);
    setModelStatus(res.status);
  };

  const handleRollback = async () => {
    const res = await rollbackOfflineModel();
    setActionMsg(res.message);
    setModelStatus(res.status);
  };

  const handleReviewDecision = async (
    id: string,
    decision: 'approved' | 'rejected',
    correctedIntent?: EmergencyId | 'unknown'
  ) => {
    try {
      const res = await fetch('/api/learning/review', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${reviewerToken.trim()}`,
        },
        body: JSON.stringify({id, decision, correctedIntent}),
      });
      if (res.ok) {
        await loadReviewerQueue();
      }
    } catch {
      // Ignore
    }
  };

  const handleDownloadFeedbackJson = () => {
    const json = exportLocalFeedbackJson();
    const blob = new Blob([json], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rakshak-feedback-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportTrainingJson = () => {
    const trainingBundle = {
      exportedAt: new Date().toISOString(),
      emergencyEvents: supabaseEvents,
      feedback: supabaseFeedback,
      localQueue: queueItems,
      localFeedback,
    };
    const blob = new Blob([JSON.stringify(trainingBundle, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rakshak-training-export-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleWithdrawAndDelete = async () => {
    const res = await withdrawConsentAndDeleteData();
    setActionMsg(res.message);
    refreshLocal();
  };

  return (
    <section className="mx-auto max-w-5xl px-4 py-6 pb-24 sm:px-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-[#0F1E36]">
            Rakshak Developer & Reviewer Dashboard
          </h1>
          <p className="text-sm text-slate-600">
            Offline model verification, version rollback, anonymized learning
            review, and consent controls.
          </p>
        </div>

        <button
          type="button"
          onClick={onBackHome}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-[#0F1E36] hover:bg-slate-50"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span>Back to App</span>
        </button>
      </div>

      {/* Honest Continuous Learning Disclosure */}
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs sm:text-sm text-slate-700 space-y-1">
        <p className="font-bold text-[#0F1E36]">
          Architecture Note: Controlled Offline Retraining (Not On-Device / Not
          Federated Learning)
        </p>
        <p>
          Rakshak never retrains models silently on user devices and does not
          claim federated learning. Only explicitly consented, PII-scrubbed
          feedback signals enter the encrypted review queue, require manual
          approval, pass <code>npm run retrain</code> +{' '}
          <code>safety-eval.js</code> gates, and ship as SHA-256 verified
          versioned models.
        </p>
      </div>

      {/* Offline Model Integrity & Versioning */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xs space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-700" />
            <h2 className="text-lg font-extrabold text-[#0F1E36]">
              Offline Classifier Model (v{modelStatus.activeVersion})
            </h2>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleCheckUpdates}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-[#0F1E36] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#162947]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Check Model Update</span>
            </button>
            <button
              type="button"
              onClick={handleRollback}
              disabled={!modelStatus.previousVersion}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-[#0F1E36] hover:bg-slate-50 disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Rollback Previous</span>
            </button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-4 text-xs sm:text-sm">
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
            <span className="text-slate-500 font-semibold">Integrity</span>
            <p className="font-extrabold text-emerald-800 mt-0.5">
              {modelStatus.verified ? 'SHA-256 Verified' : 'Unverified'}
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
            <span className="text-slate-500 font-semibold">Val Accuracy</span>
            <p className="font-mono-nums font-extrabold text-[#0F1E36] mt-0.5">
              {modelStatus.accuracy !== null
                ? `${(modelStatus.accuracy * 100).toFixed(2)}%`
                : '—'}
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
            <span className="text-slate-500 font-semibold">Macro F1</span>
            <p className="font-mono-nums font-extrabold text-[#0F1E36] mt-0.5">
              {modelStatus.macroF1 !== null
                ? `${(modelStatus.macroF1 * 100).toFixed(2)}%`
                : '—'}
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
            <span className="text-slate-500 font-semibold">Source</span>
            <p className="font-bold text-[#0F1E36] mt-0.5">
              {modelStatus.source}
            </p>
          </div>
        </div>

        {modelStatus.sha256 && (
          <p className="font-mono-nums text-xs text-slate-500 break-all">
            SHA-256: {modelStatus.sha256}
          </p>
        )}

        <label className="flex items-center gap-2 text-xs sm:text-sm font-semibold text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={wifiPref}
            onChange={(e) => {
              setWifiPref(e.target.checked);
              setWifiAndChargingOnlyPreference(e.target.checked);
            }}
            className="h-4 w-4 rounded border-slate-300"
          />
          <span>
            Prefer Wi-Fi / non-cellular &amp; adequate battery when downloading
            model updates
          </span>
        </label>

        {actionMsg && (
          <p className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs font-bold text-emerald-900">
            {actionMsg}
          </p>
        )}
      </div>

      {/* Consent & Local Privacy Controls */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xs space-y-4">
        <h2 className="text-lg font-extrabold text-[#0F1E36]">
          Consent &amp; Local Feedback Controls ({localFeedback.length} local
          entries)
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm font-bold text-[#0F1E36] cursor-pointer">
            <input
              type="checkbox"
              checked={consentState.consented}
              onChange={(e) => {
                setConsentState(setLearningConsent(e.target.checked));
              }}
              className="h-4 w-4 rounded border-slate-300"
            />
            <span>Opt-in Learning Consent</span>
          </label>

          <button
            type="button"
            onClick={handleDownloadFeedbackJson}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-[#0F1E36] hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export feedback.json (for npm run retrain)</span>
          </button>

          <button
            type="button"
            onClick={handleExportTrainingJson}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-[#0F1E36] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#162947]"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export Training JSON</span>
          </button>

          <button
            type="button"
            onClick={handleWithdrawAndDelete}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2 text-xs font-bold text-[#DC2626] hover:bg-red-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Withdraw Consent &amp; Delete All Signals</span>
          </button>
        </div>
      </div>

      {/* Protected Reviewer Queue & Remote Supabase Telemetry */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xs space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-[#0F1E36]" />
            <h2 className="text-lg font-extrabold text-[#0F1E36]">
              Authorized Reviewer &amp; Supabase Dashboard
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={reviewerToken}
              onChange={(e) => setReviewerToken(e.target.value)}
              placeholder="RAKSHAK_ADMIN_TOKEN"
              className="min-h-[38px] rounded-xl border border-slate-300 px-3 text-xs font-mono-nums"
            />
            <button
              type="button"
              onClick={loadReviewerQueue}
              disabled={queueLoading}
              className="min-h-[38px] rounded-xl bg-[#0F1E36] px-3.5 py-1.5 text-xs font-bold text-white hover:bg-[#162947]"
            >
              {queueLoading ? 'Loading...' : 'Load Data'}
            </button>
          </div>
        </div>

        {queueError && (
          <p className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs font-bold text-amber-900">
            {queueError}
          </p>
        )}

        {supabaseNote && (
          <p className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700">
            {supabaseNote}
          </p>
        )}

        {supabaseEvents.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-extrabold text-[#0F1E36]">
              Recent Supabase Emergency Phrases ({supabaseEvents.length})
            </h3>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {supabaseEvents.map((ev) => (
                <div
                  key={ev.id}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="space-y-0.5">
                    <p className="font-bold text-[#0F1E36]">
                      &ldquo;{ev.phrase}&rdquo;
                    </p>
                    <p className="text-slate-600">
                      Intent: <strong>{ev.matched_intent}</strong> · Source:{' '}
                      <strong>{ev.source}</strong> · Lang: {ev.language}
                      {typeof ev.confidence === 'number'
                        ? ` · Conf: ${Math.round(ev.confidence * 100)}%`
                        : ''}
                      {ev.approx_lat != null && ev.approx_lng != null
                        ? ` · Coords: ${ev.approx_lat}, ${ev.approx_lng}`
                        : ''}
                    </p>
                  </div>
                  <span className="font-mono-nums text-slate-500">
                    {new Date(ev.created_at).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {supabaseFeedback.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-extrabold text-[#0F1E36]">
              Recent Supabase User Feedback ({supabaseFeedback.length})
            </h3>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {supabaseFeedback.map((fb) => (
                <div
                  key={fb.id}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2"
                >
                  <div>
                    <span
                      className={`mr-2 inline-block rounded px-1.5 py-0.5 font-bold ${
                        fb.is_correct
                          ? 'bg-emerald-100 text-emerald-900'
                          : 'bg-amber-100 text-amber-900'
                      }`}
                    >
                      {fb.is_correct ? 'YES' : 'NO'}
                    </span>
                    <span className="font-bold text-[#0F1E36]">
                      &ldquo;{fb.phrase}&rdquo;
                    </span>{' '}
                    <span className="text-slate-600">
                      ({fb.matched_intent}
                      {fb.corrected_intent ? ` → ${fb.corrected_intent}` : ''})
                    </span>
                  </div>
                  <span className="font-mono-nums text-slate-500">
                    {new Date(fb.created_at).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {queueItems.length === 0 &&
        supabaseEvents.length === 0 &&
        supabaseFeedback.length === 0 &&
        !queueError ? (
          <p className="text-xs text-slate-500">
            No signals loaded yet (enter RAKSHAK_ADMIN_TOKEN and click Load
            Data).
          </p>
        ) : (
          queueItems.length > 0 && (
            <div className="space-y-2.5">
              <h3 className="text-sm font-extrabold text-[#0F1E36]">
                Encrypted Local Reviewer Queue ({queueItems.length})
              </h3>
              {queueItems.map((item) => (
                <div
                  key={item.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                >
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-[#0F1E36]">
                      &ldquo;{item.sanitizedText}&rdquo;
                    </p>
                    <p className="text-xs text-slate-600">
                      Pred: <strong>{item.predictedIntent}</strong> (
                      {Math.round(item.confidence * 100)}%) → Correction:{' '}
                      <strong>{item.correctedIntent}</strong> · Status:{' '}
                      <span className="uppercase font-bold">{item.status}</span>
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      defaultValue={item.correctedIntent}
                      onChange={(e) =>
                        handleReviewDecision(
                          item.id,
                          'approved',
                          e.target.value as EmergencyId
                        )
                      }
                      className="min-h-[36px] rounded-lg border border-slate-300 bg-white px-2 text-xs font-semibold"
                    >
                      {protocols.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.id}
                        </option>
                      ))}
                      <option value="unknown">unknown</option>
                    </select>
                    <button
                      type="button"
                      onClick={() =>
                        handleReviewDecision(
                          item.id,
                          'approved',
                          item.correctedIntent
                        )
                      }
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => handleReviewDecision(item.id, 'rejected')}
                      className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-bold text-[#DC2626]"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>

      {/* Local Low-Confidence Logs */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xs space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-extrabold text-[#0F1E36]">
            Local Low-Confidence Queries ({lowConfLogs.length})
          </h2>
          {lowConfLogs.length > 0 && (
            <button
              type="button"
              onClick={() => {
                clearLowConfidenceLocalLogs();
                setLowConfLogs([]);
              }}
              className="text-xs font-bold text-[#DC2626] underline"
            >
              Clear local logs
            </button>
          )}
        </div>
        {lowConfLogs.length === 0 ? (
          <p className="text-xs text-slate-500">
            No low-confidence local entries recorded on this device.
          </p>
        ) : (
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {lowConfLogs.map((log, i) => (
              <div
                key={`${log.timestamp}-${i}`}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs flex flex-wrap justify-between gap-2"
              >
                <span className="font-semibold text-[#0F1E36]">
                  &ldquo;{log.sanitizedText}&rdquo;
                </span>
                <span className="font-mono-nums text-slate-600">
                  {log.predictedIntent} ({Math.round(log.confidence * 100)}%)
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
