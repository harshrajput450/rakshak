import React, {useEffect, useState} from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  MapPin,
  MessageSquare,
  PhoneCall,
  Plus,
  Send,
  Trash2,
  UserPlus,
} from 'lucide-react';
import {UI_COPY, t} from '../i18n/translations';
import type {EmergencyProtocol, Language, TrustedContact} from '../types/emergency';

interface Props {
  lang: Language;
  protocols: EmergencyProtocol[];
  selectedEmergencyId?: string;
}

const CONTACTS_STORAGE_KEY = 'goldenhour_trusted_contacts';

function loadContacts(): TrustedContact[] {
  try {
    const raw = localStorage.getItem(CONTACTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 3) : [];
  } catch {
    return [];
  }
}

interface PendingSendAction {
  channel: 'WhatsApp' | 'SMS';
  recipientLabel: string;
  href: string;
  targetBlank?: boolean;
}

export const SOSScreen: React.FC<Props> = ({
  lang,
  protocols,
  selectedEmergencyId,
}) => {
  const [contacts, setContacts] = useState<TrustedContact[]>(loadContacts);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [emergencyType, setEmergencyType] = useState<string>(
    selectedEmergencyId || 'Medical Emergency'
  );
  const [coords, setCoords] = useState<{lat: number; lng: number} | null>(null);
  const [locStatus, setLocStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [locError, setLocError] = useState('');
  const [copied, setCopied] = useState(false);
  const [pendingAction, setPendingAction] =
    useState<PendingSendAction | null>(null);

  const isOffline =
    typeof navigator !== 'undefined' ? !navigator.onLine : false;

  useEffect(() => {
    if (selectedEmergencyId) {
      const match = protocols.find((p) => p.id === selectedEmergencyId);
      if (match) {
        setEmergencyType(match.title.en);
      }
    }
  }, [selectedEmergencyId, protocols]);

  useEffect(() => {
    try {
      localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(contacts));
    } catch {
      // Ignore storage quota error
    }
  }, [contacts]);

  const fetchLiveLocation = () => {
    if (!('geolocation' in navigator)) {
      setLocStatus('error');
      setLocError(
        lang === 'hi'
          ? 'इस डिवाइस में GPS उपलब्ध नहीं है।'
          : 'Geolocation is not supported on this device.'
      );
      return;
    }

    setLocStatus('loading');
    setLocError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({
          lat: Number(pos.coords.latitude.toFixed(6)),
          lng: Number(pos.coords.longitude.toFixed(6)),
        });
        setLocStatus('ready');
      },
      (err) => {
        setLocStatus('error');
        setLocError(
          err.message ||
            (lang === 'hi'
              ? 'लोकेशन अनुमति नहीं मिली।'
              : 'Could not get GPS location. Please enable location permission.')
        );
      },
      {enableHighAccuracy: true, timeout: 10000, maximumAge: 30000}
    );
  };

  const mapsLink = coords
    ? `https://maps.google.com/?q=${coords.lat},${coords.lng}`
    : lang === 'hi'
    ? '[लोकेशन उपलब्ध नहीं — कृपया पता बताएं]'
    : '[Location unavailable — please call me]';

  const sosMessage = `Emergency! Need help at: ${mapsLink}. Situation: ${emergencyType}`;
  const encodedMsg = encodeURIComponent(sosMessage);

  const normalizeDigits = (phone: string) => phone.replace(/[^\d+]/g, '');

  const handleSaveContact = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = newName.trim();
    const trimmedPhone = newPhone.trim();
    if (!trimmedName || !trimmedPhone) return;

    if (editingId) {
      setContacts((prev) =>
        prev.map((c) =>
          c.id === editingId
            ? {...c, name: trimmedName, phone: trimmedPhone}
            : c
        )
      );
      setEditingId(null);
    } else if (contacts.length < 3) {
      setContacts((prev) => [
        ...prev,
        {
          id: `${Date.now()}`,
          name: trimmedName,
          phone: trimmedPhone,
        },
      ]);
    }
    setNewName('');
    setNewPhone('');
  };

  const handleEditContact = (c: TrustedContact) => {
    setEditingId(c.id);
    setNewName(c.name);
    setNewPhone(c.phone);
  };

  const handleDeleteContact = (id: string) => {
    setContacts((prev) => prev.filter((c) => c.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setNewName('');
      setNewPhone('');
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sosMessage);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard failures
    }
  };

  return (
    <section className="mx-auto max-w-4xl px-4 py-5 pb-24 sm:px-6 md:pb-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-[#0F1E36]">
            {lang === 'hi' ? 'तुरंत SOS मदद भेजें' : 'Emergency SOS Alert'}
          </h1>
          <p className="text-base text-slate-600">
            {lang === 'hi'
              ? 'अपनी लाइव लोकेशन अपने भरोसेमंद संपर्कों को भेजें।'
              : 'Share your live GPS location and situation with trusted contacts.'}
          </p>
        </div>

        <a
          href="tel:112"
          className="inline-flex min-h-[56px] items-center gap-2 rounded-2xl bg-[#DC2626] px-5 py-3 text-lg font-extrabold text-white shadow-sm hover:bg-red-700"
        >
          <PhoneCall className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span>{t(UI_COPY.call112, lang)}</span>
        </a>
      </div>

      {isOffline && (
        <div
          role="status"
          className="mt-4 flex items-start gap-2.5 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950"
        >
          <AlertTriangle
            className="h-5 w-5 text-amber-700 shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <span>
            {lang === 'hi'
              ? 'ऑफ़लाइन चेतावनी: इंटरनेट के बिना WhatsApp संदेश नहीं जाएगा। आप मोबाइल नेटवर्क से SMS भेज सकते हैं या सीधे 112 पर कॉल करें।'
              : 'Offline warning: WhatsApp requires internet. Use SMS (cellular signal) or call 112 directly if you have no internet.'}
          </span>
        </div>
      )}

      {pendingAction && (
        <div
          role="dialog"
          aria-modal="true"
          className="mt-4 rounded-2xl border-2 border-[#DC2626] bg-red-50 p-5 space-y-3 shadow-sm"
        >
          <p className="text-base font-extrabold text-[#0F1E36]">
            {lang === 'hi'
              ? `${pendingAction.channel} से "${pendingAction.recipientLabel}" को SOS संदेश भेजने की पुष्टि करें?`
              : `Confirm opening ${pendingAction.channel} to send this SOS alert to ${pendingAction.recipientLabel}?`}
          </p>
          <p className="text-xs sm:text-sm font-medium text-slate-700 bg-white rounded-xl border border-red-200 p-3 break-words">
            {sosMessage}
          </p>
          <div className="flex flex-wrap gap-2.5">
            <a
              href={pendingAction.href}
              target={pendingAction.targetBlank ? '_blank' : undefined}
              rel={pendingAction.targetBlank ? 'noopener noreferrer' : undefined}
              onClick={() => setPendingAction(null)}
              className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#DC2626] px-5 py-2.5 text-sm font-extrabold text-white hover:bg-red-700"
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              <span>
                {lang === 'hi'
                  ? `हाँ, ${pendingAction.channel} खोलें`
                  : `Confirm & Open ${pendingAction.channel}`}
              </span>
            </a>
            <button
              type="button"
              onClick={() => setPendingAction(null)}
              className="inline-flex min-h-[48px] items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-[#0F1E36] hover:bg-slate-50"
            >
              {lang === 'hi' ? 'रद्द करें' : 'Cancel'}
            </button>
          </div>
        </div>
      )}

      <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <button
          type="button"
          onClick={fetchLiveLocation}
          className="flex min-h-[64px] w-full items-center justify-center gap-3 rounded-2xl bg-[#DC2626] px-6 py-4 text-xl font-extrabold text-white shadow-sm hover:bg-red-700 active:scale-[0.99] transition-transform"
        >
          <MapPin className="h-6 w-6 shrink-0" aria-hidden="true" />
          <span>
            {locStatus === 'loading'
              ? lang === 'hi'
                ? 'लोकेशन खोज रहे हैं...'
                : 'Getting Live Location...'
              : coords
              ? lang === 'hi'
                ? 'लोकेशन अपडेट करें'
                : 'Refresh Live Location'
              : lang === 'hi'
              ? '1. लाइव लोकेशन लें (SOS तैयार करें)'
              : '1. Get Live Location for SOS'}
          </span>
        </button>

        {coords && (
          <p className="font-mono-nums mt-3 text-sm font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2">
            GPS: {coords.lat}, {coords.lng}
          </p>
        )}

        {locError && (
          <p className="mt-3 text-sm font-semibold text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-2">
            {locError}
          </p>
        )}

        <div className="mt-5">
          <label
            htmlFor="sos-situation"
            className="block text-sm font-bold text-[#0F1E36]"
          >
            {lang === 'hi' ? 'आपात स्थिति चुनें' : 'Emergency Situation'}
          </label>
          <select
            id="sos-situation"
            value={emergencyType}
            onChange={(e) => setEmergencyType(e.target.value)}
            className="mt-1.5 min-h-[56px] w-full rounded-xl border border-slate-300 bg-white px-4 text-base font-semibold text-[#0F1E36]"
          >
            <option value="Medical Emergency">
              {lang === 'hi' ? 'सामान्य मेडिकल इमरजेंसी' : 'Medical Emergency'}
            </option>
            {protocols.map((p) => (
              <option key={p.id} value={p.title.en}>
                {p.title[lang]} ({p.title.en})
              </option>
            ))}
          </select>
        </div>

        <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-bold text-slate-600">
              {lang === 'hi' ? 'तैयार SOS संदेश' : 'SOS Message Preview'}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1 text-sm font-bold text-[#0F1E36] hover:bg-slate-100"
            >
              {copied ? (
                <Check className="h-4 w-4 text-emerald-700" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              <span>
                {copied
                  ? lang === 'hi'
                    ? 'कॉपी हुआ'
                    : 'Copied'
                  : lang === 'hi'
                  ? 'कॉपी'
                  : 'Copy'}
              </span>
            </button>
          </div>
          <p className="mt-2 break-words text-base font-semibold text-[#0F1E36]">
            {sosMessage}
          </p>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() =>
              setPendingAction({
                channel: 'WhatsApp',
                recipientLabel:
                  lang === 'hi' ? 'चयनित WhatsApp संपर्क' : 'WhatsApp contact',
                href: `https://wa.me/?text=${encodedMsg}`,
                targetBlank: true,
              })
            }
            className="flex min-h-[56px] items-center justify-center gap-2 rounded-2xl bg-[#15803D] px-5 py-3 text-base font-extrabold text-white hover:bg-green-800"
          >
            <Send className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>
              {lang === 'hi' ? 'WhatsApp पर भेजें' : 'Share via WhatsApp'}
            </span>
          </button>

          <button
            type="button"
            onClick={() =>
              setPendingAction({
                channel: 'SMS',
                recipientLabel:
                  lang === 'hi' ? 'चयनित SMS संपर्क' : 'SMS recipient',
                href: `sms:?body=${encodedMsg}`,
              })
            }
            className="flex min-h-[56px] items-center justify-center gap-2 rounded-2xl bg-[#0F1E36] px-5 py-3 text-base font-extrabold text-white hover:bg-[#162947]"
          >
            <MessageSquare className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{lang === 'hi' ? 'SMS भेजें' : 'Send via SMS'}</span>
          </button>
        </div>
      </div>

      <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2.5">
          <UserPlus className="h-6 w-6 text-[#DC2626]" aria-hidden="true" />
          <h2 className="text-xl font-extrabold text-[#0F1E36]">
            {lang === 'hi'
              ? '3 भरोसेमंद संपर्क (Trusted Contacts)'
              : 'Trusted Contacts (Up to 3)'}
          </h2>
        </div>

        {contacts.length === 0 ? (
          <p className="mt-3 text-base text-slate-600">
            {lang === 'hi'
              ? 'अभी कोई संपर्क सेव नहीं है। नीचे परिवार या दोस्त का नंबर जोड़ें।'
              : 'No trusted contacts saved yet. Add up to 3 family members or friends below.'}
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {contacts.map((c) => {
              const digits = normalizeDigits(c.phone);
              const waDigits = digits.replace(/^\+/, '');
              return (
                <div
                  key={c.id}
                  className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-lg font-extrabold text-[#0F1E36]">
                      {c.name}
                    </p>
                    <p className="font-mono-nums text-sm font-semibold text-slate-600">
                      {c.phone}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setPendingAction({
                          channel: 'WhatsApp',
                          recipientLabel: c.name,
                          href: `https://wa.me/${waDigits}?text=${encodedMsg}`,
                          targetBlank: true,
                        })
                      }
                      className="inline-flex min-h-[48px] items-center gap-1.5 rounded-xl bg-[#15803D] px-4 py-2 text-sm font-bold text-white hover:bg-green-800"
                    >
                      <Send className="h-4 w-4" aria-hidden="true" />
                      <span>WhatsApp</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setPendingAction({
                          channel: 'SMS',
                          recipientLabel: c.name,
                          href: `sms:${digits}?body=${encodedMsg}`,
                        })
                      }
                      className="inline-flex min-h-[48px] items-center gap-1.5 rounded-xl bg-[#0F1E36] px-4 py-2 text-sm font-bold text-white hover:bg-[#162947]"
                    >
                      <MessageSquare className="h-4 w-4" aria-hidden="true" />
                      <span>SMS</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleEditContact(c)}
                      className="min-h-[48px] rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-[#0F1E36] hover:bg-slate-100"
                    >
                      {lang === 'hi' ? 'बदलें' : 'Edit'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteContact(c.id)}
                      aria-label={`Remove ${c.name}`}
                      className="min-h-[48px] min-w-[48px] flex items-center justify-center rounded-xl border border-red-200 bg-white text-[#DC2626] hover:bg-red-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {(contacts.length < 3 || editingId) && (
          <form
            onSubmit={handleSaveContact}
            className="mt-5 grid gap-3 border-t border-slate-100 pt-5 sm:grid-cols-3"
          >
            <input
              type="text"
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={lang === 'hi' ? 'नाम (जैसे: माँ)' : 'Name (e.g. Mom)'}
              className="min-h-[56px] rounded-xl border border-slate-300 bg-white px-4 text-base font-medium text-[#0F1E36]"
            />
            <input
              type="tel"
              required
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder={
                lang === 'hi' ? 'फोन (+9198...)' : 'Phone (e.g. +9198...)'
              }
              className="min-h-[56px] rounded-xl border border-slate-300 bg-white px-4 text-base font-medium text-[#0F1E36]"
            />
            <button
              type="submit"
              className="inline-flex min-h-[56px] items-center justify-center gap-2 rounded-xl bg-[#0F1E36] px-5 text-base font-bold text-white hover:bg-[#162947]"
            >
              <Plus className="h-5 w-5" aria-hidden="true" />
              <span>
                {editingId
                  ? lang === 'hi'
                    ? 'अपडेट करें'
                    : 'Update Contact'
                  : lang === 'hi'
                  ? 'संपर्क जोड़ें'
                  : 'Save Contact'}
              </span>
            </button>
          </form>
        )}
      </div>

      <footer className="mt-6 border-t border-slate-200 pt-4 text-center text-sm font-semibold text-slate-600">
        {t(UI_COPY.safetyFooter, lang)}
      </footer>
    </section>
  );
};
