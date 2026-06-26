"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Upload, Copy, Check, FileText, Zap, AlertCircle, Download } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

const API = "https://doctomd-sacp.onrender.com";
const FREE_LIMIT_MB = 5;
const UPI_ID = "rishabhs1898@okicici";
const UPI_NAME = "DocToMD";

// Must match backend PAID_TIERS
const PRICE_TIERS = [
  { maxMb: 20,  priceInr: 10,  label: "5–20 MB" },
  { maxMb: 50,  priceInr: 20,  label: "20–50 MB" },
  { maxMb: 200, priceInr: 49,  label: "50–200 MB" },
];

function getPriceForSize(mb: number): { priceInr: number; label: string } | null {
  if (mb <= FREE_LIMIT_MB) return null;
  return PRICE_TIERS.find(t => mb <= t.maxMb) ?? PRICE_TIERS[PRICE_TIERS.length - 1];
}

type Status = "idle" | "pay_required" | "paying" | "uploading" | "done" | "error";

declare global {
  interface Window { Razorpay: new (opts: unknown) => { open: () => void }; }
}

export default function Home() {
  const [status, setStatus]     = useState<Status>("idle");
  const [markdown, setMarkdown] = useState("");
  const [error, setError]       = useState("");
  const [stats, setStats]       = useState({ size_mb: 0, word_count: 0, char_count: 0, filename: "" });
  const [copied, setCopied]     = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPrice, setPendingPrice] = useState<{ priceInr: number; label: string } | null>(null);
  const [unlimitedToken, setUnlimitedToken] = useState("");
  const [buyingUnlimited, setBuyingUnlimited] = useState(false);
  const [showUnlimitedQR, setShowUnlimitedQR] = useState(false);
  const [utr, setUtr] = useState("");
  const [utrError, setUtrError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    document.body.appendChild(s);
    // Restore unlimited token (only Razorpay-verified ones, not fake upi_ tokens)
    const saved = localStorage.getItem("doctomd_unlimited");
    if (saved && !saved.startsWith("upi_")) {
      setUnlimitedToken(saved);
    } else if (saved) {
      localStorage.removeItem("doctomd_unlimited");
    }
  }, []);

  const doConvert = useCallback(async (file: File, paymentId = "", token = "") => {
    setStatus("uploading");
    setMarkdown("");
    const form = new FormData();
    form.append("file", file);
    if (paymentId) form.append("payment_id", paymentId);
    if (token) form.append("unlimited_token", token);

    try {
      const res = await fetch(`${API}/convert`, { method: "POST", body: form });
      const json = await res.json();
      if (res.status === 402) {
        // Token was invalid or expired — clear it and show payment screen
        setUnlimitedToken("");
        localStorage.removeItem("doctomd_unlimited");
        const sizeMb = json.detail?.size_mb || 0;
        const tier = getPriceForSize(sizeMb) ?? getPriceForSize(file.size / (1024 * 1024));
        if (tier) {
          setPendingFile(file);
          setPendingPrice(tier);
          setStatus("pay_required");
        }
        return;
      }
      if (!res.ok) throw new Error(json.detail?.message || json.detail || "Conversion failed");
      setMarkdown(json.markdown);
      setStats({ size_mb: json.size_mb, word_count: json.word_count, char_count: json.char_count, filename: json.filename });
      setStatus("done");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setStatus("error");
    }
  }, []);

  const handleFile = useCallback((file: File) => {
    const sizeMb = file.size / (1024 * 1024);
    if (sizeMb > 200) {
      setError("Maximum file size is 200 MB.");
      setStatus("error");
      return;
    }
    // Unlimited token holders skip payment
    if (unlimitedToken) {
      doConvert(file, "", unlimitedToken);
      return;
    }
    const tier = getPriceForSize(sizeMb);
    if (tier) {
      setPendingFile(file);
      setPendingPrice(tier);
      setStatus("pay_required");
    } else {
      doConvert(file);
    }
  }, [doConvert, unlimitedToken]);

  const handlePay = async () => {
    if (!pendingFile || !pendingPrice) return;
    setStatus("paying");
    try {
      const res = await fetch(`${API}/create-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size_mb: pendingFile.size / (1024 * 1024) }),
      });
      const order = await res.json();
      const rzp = new window.Razorpay({
        key: order.key_id,
        amount: order.amount,
        currency: "INR",
        name: "DocToMD",
        description: `Convert ${pendingFile.name}`,
        order_id: order.order_id,
        handler: async (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          // Verify then convert
          const verify = await fetch(`${API}/verify-payment`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(response),
          });
          const result = await verify.json();
          if (result.pro) {
            doConvert(pendingFile, response.razorpay_payment_id);
          } else {
            setError("Payment verification failed. Contact support.");
            setStatus("error");
          }
        },
        modal: { ondismiss: () => setStatus("pay_required") },
        theme: { color: "#facc15" },
      });
      rzp.open();
    } catch {
      setError("Could not load payment. Try again.");
      setStatus("error");
    }
  };

  const handleBuyUnlimited = async () => {
    setBuyingUnlimited(true);
    try {
      const res = await fetch(`${API}/create-unlimited-order`, { method: "POST" });
      const order = await res.json();
      const rzp = new window.Razorpay({
        key: order.key_id,
        amount: order.amount,
        currency: "INR",
        name: "DocToMD Unlimited",
        description: "Unlimited conversions, any file size",
        order_id: order.order_id,
        handler: async (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          const verify = await fetch(`${API}/verify-payment`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...response, type: "unlimited" }),
          });
          const result = await verify.json();
          if (result.pro) {
            setUnlimitedToken(result.payment_id);
            localStorage.setItem("doctomd_unlimited", result.payment_id);
          }
        },
        theme: { color: "#facc15" },
      });
      rzp.open();
    } catch {
      alert("Payment failed to load. Try again.");
    } finally {
      setBuyingUnlimited(false);
    }
  };

  const handleUpiPaid = useCallback(() => {
    if (utr.trim().length < 10) {
      setUtrError("Enter a valid UTR number (12 digits from your UPI app)");
      return;
    }
    setUtrError("");
    if (pendingFile) doConvert(pendingFile, utr.trim());
  }, [utr, pendingFile, doConvert]);

  const handleUnlimitedUpiPaid = useCallback(() => {
    if (utr.trim().length < 10) {
      setUtrError("Enter a valid UTR number (12 digits from your UPI app)");
      return;
    }
    setUtrError("");
    const token = `upi_${utr.trim()}`;
    setUnlimitedToken(token);
    localStorage.setItem("doctomd_unlimited", token);
    setStatus("idle");
    setUtr("");
  }, [utr]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const copyMd = async () => {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadMd = () => {
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = stats.filename.replace(/\.(pdf|docx?)$/i, ".md");
    a.click();
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    setStatus("idle");
    setMarkdown("");
    setError("");
    setPendingFile(null);
    setPendingPrice(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const showUpload = status === "idle" || status === "error";

  return (
    <main className="min-h-screen bg-[#0f0f0f] text-white font-sans">
      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap size={20} className="text-yellow-400" />
          <span className="font-bold text-lg tracking-tight">DocToMD</span>
        </div>
        {unlimitedToken ? (
          <span className="text-xs bg-yellow-400/20 text-yellow-400 px-3 py-1.5 rounded-full font-medium">
            ✦ Unlimited Active
          </span>
        ) : (
          <button
            onClick={() => { setShowUnlimitedQR(true); setUtr(""); setUtrError(""); }}
            className="text-sm px-4 py-1.5 rounded-lg bg-yellow-400 text-black font-semibold hover:bg-yellow-300 transition-colors"
          >
            ₹499 Unlimited
          </button>
        )}
      </header>

      <div className="max-w-5xl mx-auto px-6 py-12">
        {/* Hero */}
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold mb-3 tracking-tight">PDF & Word → Markdown</h1>
          <p className="text-white/50 text-lg">Convert documents for Claude, ChatGPT, Cursor, Obsidian. Under 5 MB is always free.</p>
        </div>

        {/* Upload Zone */}
        {showUpload && (
          <div
            className={`border-2 border-dashed rounded-2xl p-16 text-center cursor-pointer transition-all ${
              dragging ? "border-yellow-400 bg-yellow-400/5" : "border-white/20 hover:border-white/40 hover:bg-white/[0.03]"
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
          >
            <input ref={inputRef} type="file" accept=".pdf,.docx,.doc" className="hidden" onChange={onFileChange} />
            <Upload size={40} className="mx-auto mb-4 text-white/30" />
            <p className="text-xl font-medium mb-2">Drop your file here</p>
            <p className="text-white/40 text-sm">PDF, DOCX, DOC · Up to 200 MB</p>
            {status === "error" && (
              <div className="mt-6 flex items-center gap-2 justify-center text-red-400 text-sm">
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
            )}
          </div>
        )}

        {/* Payment screen — per file */}
        {(status === "pay_required" || status === "paying") && pendingFile && pendingPrice && (
          <div className="border border-white/10 rounded-2xl p-8 max-w-lg mx-auto space-y-6">
            {/* File info */}
            <div className="text-center">
              <p className="text-lg font-semibold mb-1">{pendingFile.name}</p>
              <p className="text-white/40 text-sm">{(pendingFile.size / (1024 * 1024)).toFixed(1)} MB · {pendingPrice.label}</p>
              <p className="text-3xl font-bold text-yellow-400 mt-2">₹{pendingPrice.priceInr}</p>
            </div>

            {/* Option 1 — Razorpay (cards, UPI, netbanking) */}
            <div className="bg-white/5 border border-white/10 rounded-xl p-5 space-y-3">
              <p className="text-sm font-medium text-white/70">Option 1 — Pay via Razorpay</p>
              <p className="text-xs text-white/30">Cards · UPI · Netbanking · Wallets · Auto-verified</p>
              <button
                onClick={handlePay}
                disabled={status === "paying"}
                className="w-full py-3 bg-yellow-400 text-black font-semibold rounded-xl hover:bg-yellow-300 transition-colors disabled:opacity-50"
              >
                {status === "paying" ? "Opening…" : `Pay ₹${pendingPrice.priceInr} via Razorpay`}
              </button>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-white/10" />
              <span className="text-white/20 text-xs">or</span>
              <div className="flex-1 h-px bg-white/10" />
            </div>

            {/* Option 2 — UPI QR */}
            <div className="bg-white/5 border border-white/10 rounded-xl p-5 space-y-4">
              <p className="text-sm font-medium text-white/70">Option 2 — Scan UPI QR</p>
              <p className="text-xs text-white/30">GPay · PhonePe · Paytm · any UPI app</p>
              <div className="flex justify-center">
                <div className="bg-white p-3 rounded-xl">
                  <QRCodeSVG
                    value={`upi://pay?pa=${UPI_ID}&pn=${encodeURIComponent(UPI_NAME)}&am=${pendingPrice.priceInr}&cu=INR&tn=${encodeURIComponent(`DocToMD - ${pendingFile.name}`)}`}
                    size={150}
                  />
                </div>
              </div>
              <p className="text-center text-white/30 text-xs">{UPI_ID}</p>
              <div className="space-y-2">
                <input
                  type="text"
                  value={utr}
                  onChange={e => { setUtr(e.target.value); setUtrError(""); }}
                  placeholder="Enter UTR number after paying"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/20 focus:outline-none focus:border-yellow-400/50 text-sm"
                />
                {utrError && <p className="text-red-400 text-xs">{utrError}</p>}
                <p className="text-white/20 text-xs">GPay → transaction → UTR number (12 digits)</p>
                <button
                  onClick={handleUpiPaid}
                  className="w-full py-3 bg-white/10 border border-white/20 text-white font-medium rounded-xl hover:bg-white/20 transition-colors"
                >
                  I've Paid via UPI — Convert Now
                </button>
              </div>
            </div>

            <button onClick={reset} className="w-full text-sm text-white/30 hover:text-white/50 transition-colors">
              Cancel
            </button>
          </div>
        )}

        {/* Converting */}
        {status === "uploading" && (
          <div className="border-2 border-dashed border-yellow-400/40 rounded-2xl p-16 text-center">
            <div className="w-8 h-8 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-white/60">Converting your document…</p>
          </div>
        )}

        {/* Result */}
        {status === "done" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between bg-white/5 rounded-xl px-5 py-3 flex-wrap gap-3">
              <div className="flex items-center gap-2 text-sm text-white/60">
                <FileText size={14} />
                <span className="text-white font-medium">{stats.filename}</span>
                <span>·</span>
                <span>{stats.size_mb} MB</span>
                <span>·</span>
                <span>{stats.word_count.toLocaleString()} words</span>
                <span>·</span>
                <span>{stats.char_count.toLocaleString()} chars</span>
              </div>
              <div className="flex gap-2">
                <button onClick={downloadMd} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors">
                  <Download size={14} /> .md
                </button>
                <button onClick={copyMd} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-yellow-400 text-black font-medium hover:bg-yellow-300 transition-colors">
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "Copied!" : "Copy MD"}
                </button>
                <button onClick={reset} className="text-sm px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors text-white/60">
                  New file
                </button>
              </div>
            </div>
            <pre className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 text-sm text-white/80 overflow-auto max-h-[60vh] whitespace-pre-wrap font-mono leading-relaxed">
              {markdown}
            </pre>
          </div>
        )}

        {/* Pricing table */}
        {(status === "idle" || status === "error") && (
          <div className="mt-16">
            <p className="text-center text-white/30 text-sm mb-6">Pricing</p>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {[
                { range: "Under 5 MB",  price: "Free", sub: "Always free" },
                { range: "5 – 20 MB",   price: "₹10",  sub: "per file" },
                { range: "20 – 50 MB",  price: "₹20",  sub: "per file" },
                { range: "50 – 200 MB", price: "₹49",  sub: "per file" },
                { range: "Unlimited",   price: "₹499", sub: "any size, forever" },
              ].map(t => (
                <div key={t.range} className="bg-white/[0.03] border border-white/[0.08] rounded-xl p-4 text-center">
                  <p className="text-white/40 text-xs mb-2">{t.range}</p>
                  <p className="text-xl font-bold text-yellow-400">{t.price}</p>
                  <p className="text-white/30 text-xs mt-1">{t.sub}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Features */}
        <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm text-white/50">
          {[
            { icon: "⚡", title: "Instant", desc: "Converts in seconds, no signup needed" },
            { icon: "🔒", title: "Private", desc: "Files not stored — processed and discarded" },
            { icon: "🤖", title: "AI-ready", desc: "Clean MD for Claude, GPT, Cursor, Obsidian" },
          ].map((f) => (
            <div key={f.title} className="bg-white/[0.03] border border-white/[0.08] rounded-xl p-5 text-center">
              <div className="text-2xl mb-2">{f.icon}</div>
              <div className="font-medium text-white/80 mb-1">{f.title}</div>
              <div>{f.desc}</div>
            </div>
          ))}
        </div>
      </div>
      {/* ₹499 Unlimited QR Modal */}
      {showUnlimitedQR && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-8 max-w-sm w-full space-y-5">
            <div className="text-center">
              <p className="text-xl font-bold mb-1">₹499 Unlimited</p>
              <p className="text-white/40 text-sm">Any file size · unlimited conversions · forever</p>
            </div>

            <div className="flex flex-col items-center gap-2">
              <div className="bg-white p-4 rounded-2xl">
                <QRCodeSVG
                  value={`upi://pay?pa=${UPI_ID}&pn=${encodeURIComponent(UPI_NAME)}&am=499&cu=INR&tn=${encodeURIComponent("DocToMD Unlimited")}`}
                  size={180}
                />
              </div>
              <p className="text-2xl font-bold text-yellow-400">₹499</p>
              <p className="text-white/40 text-sm">Scan with GPay · PhonePe · Paytm</p>
              <p className="text-white/30 text-xs">{UPI_ID}</p>
            </div>

            <div className="space-y-2">
              <label className="text-sm text-white/50">Enter UTR / Transaction ID after paying</label>
              <input
                type="text"
                value={utr}
                onChange={e => { setUtr(e.target.value); setUtrError(""); }}
                placeholder="e.g. 123456789012"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/20 focus:outline-none focus:border-yellow-400/50"
              />
              {utrError && <p className="text-red-400 text-xs">{utrError}</p>}
            </div>

            {/* Razorpay button for unlimited */}
            <button
              onClick={handleBuyUnlimited}
              disabled={buyingUnlimited}
              className="w-full py-3 bg-yellow-400 text-black font-semibold rounded-xl hover:bg-yellow-300 transition-colors disabled:opacity-50"
            >
              {buyingUnlimited ? "Opening…" : "Pay ₹499 via Razorpay (Auto-verified)"}
            </button>

            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-white/10" />
              <span className="text-white/20 text-xs">or UPI QR</span>
              <div className="flex-1 h-px bg-white/10" />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => { handleUnlimitedUpiPaid(); if (utr.trim().length >= 10) setShowUnlimitedQR(false); }}
                className="flex-1 py-3 bg-white/10 border border-white/20 text-white font-medium rounded-xl hover:bg-white/20 transition-colors"
              >
                I've Paid via UPI — Activate
              </button>
              <button
                onClick={() => { setShowUnlimitedQR(false); setUtr(""); setUtrError(""); }}
                className="px-5 py-3 bg-white/10 rounded-xl hover:bg-white/20 transition-colors text-white/50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
