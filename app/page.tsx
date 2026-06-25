"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Upload, Copy, Check, FileText, Zap, AlertCircle, Download, Crown } from "lucide-react";

const API = "https://doctomd-production.up.railway.app";
const FREE_LIMIT_MB = 5;
const PRO_LIMIT_MB = 50;

type Status = "idle" | "uploading" | "done" | "error";

declare global {
  interface Window { Razorpay: new (opts: unknown) => { open: () => void }; }
}

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState("");
  const [stats, setStats] = useState({ size_mb: 0, word_count: 0, char_count: 0, filename: "" });
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [isPro, setIsPro] = useState(false);
  const [paying, setPaying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Load Razorpay script
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    document.body.appendChild(s);
    // Restore pro from localStorage
    const stored = localStorage.getItem("doctomd_pro");
    if (stored) setIsPro(true);
  }, []);

  const handleUpgradePro = async () => {
    setPaying(true);
    try {
      const res = await fetch(`${API}/create-order`, { method: "POST" });
      const order = await res.json();
      const rzp = new window.Razorpay({
        key: order.key_id,
        amount: order.amount,
        currency: "INR",
        name: "DocToMD Pro",
        description: "Unlimited conversions, up to 50 MB",
        order_id: order.order_id,
        handler: async (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          const verify = await fetch(`${API}/verify-payment`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(response),
          });
          const result = await verify.json();
          if (result.pro) {
            setIsPro(true);
            localStorage.setItem("doctomd_pro", result.payment_id);
          }
        },
        theme: { color: "#facc15" },
      });
      rzp.open();
    } catch {
      alert("Payment failed to load. Try again.");
    } finally {
      setPaying(false);
    }
  };

  const convert = useCallback(async (file: File) => {
    const sizeMb = file.size / (1024 * 1024);
    const limit = isPro ? PRO_LIMIT_MB : FREE_LIMIT_MB;
    if (sizeMb > limit) {
      setError(isPro
        ? `File is ${sizeMb.toFixed(1)} MB — Pro limit is ${PRO_LIMIT_MB} MB.`
        : `File is ${sizeMb.toFixed(1)} MB — free limit is ${FREE_LIMIT_MB} MB. Upgrade to Pro for up to 50 MB.`
      );
      setStatus("error");
      return;
    }

    setStatus("uploading");
    setError("");
    setMarkdown("");

    const form = new FormData();
    form.append("file", file);

    try {
      const res = await fetch(`${API}/convert`, { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail || "Conversion failed");
      setMarkdown(json.markdown);
      setStats({ size_mb: json.size_mb, word_count: json.word_count, char_count: json.char_count, filename: json.filename });
      setStatus("done");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setStatus("error");
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) convert(file);
  }, [convert, isPro]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) convert(file);
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
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <main className="min-h-screen bg-[#0f0f0f] text-white font-sans">
      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap size={20} className="text-yellow-400" />
          <span className="font-bold text-lg tracking-tight">DocToMD</span>
          <span className="text-xs bg-white/10 px-2 py-0.5 rounded-full text-white/50 ml-1">free</span>
        </div>
        {isPro ? (
          <span className="flex items-center gap-1.5 text-sm text-yellow-400 font-medium">
            <Crown size={14} /> Pro
          </span>
        ) : (
          <button
            onClick={handleUpgradePro}
            disabled={paying}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-yellow-400 text-black font-medium hover:bg-yellow-300 transition-colors disabled:opacity-50"
          >
            <Crown size={14} />
            {paying ? "Loading…" : "Upgrade ₹299/mo"}
          </button>
        )}
      </header>

      <div className="max-w-5xl mx-auto px-6 py-12">
        {/* Hero */}
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold mb-3 tracking-tight">PDF & Word → Markdown</h1>
          <p className="text-white/50 text-lg">
            Convert documents for Claude, ChatGPT, Cursor, Obsidian. Free up to {FREE_LIMIT_MB} MB.
          </p>
        </div>

        {/* Upload Zone */}
        {(status === "idle" || status === "error") && (
          <div
            className={`border-2 border-dashed rounded-2xl p-16 text-center cursor-pointer transition-all ${
              dragging
                ? "border-yellow-400 bg-yellow-400/5"
                : "border-white/20 hover:border-white/40 hover:bg-white/[0.03]"
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
          >
            <input ref={inputRef} type="file" accept=".pdf,.docx,.doc" className="hidden" onChange={onFileChange} />
            <Upload size={40} className="mx-auto mb-4 text-white/30" />
            <p className="text-xl font-medium mb-2">Drop your file here</p>
            <p className="text-white/40 text-sm">PDF, DOCX, DOC · Max {isPro ? `${PRO_LIMIT_MB} MB (Pro)` : `${FREE_LIMIT_MB} MB free`}</p>
            {status === "error" && (
              <div className="mt-6 flex items-center gap-2 justify-center text-red-400 text-sm">
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
            )}
          </div>
        )}

        {/* Loading */}
        {status === "uploading" && (
          <div className="border-2 border-dashed border-yellow-400/40 rounded-2xl p-16 text-center">
            <div className="w-8 h-8 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-white/60">Converting your document…</p>
          </div>
        )}

        {/* Result */}
        {status === "done" && (
          <div className="space-y-4">
            {/* Stats bar */}
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
                <button
                  onClick={downloadMd}
                  className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
                >
                  <Download size={14} />
                  .md
                </button>
                <button
                  onClick={copyMd}
                  className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-yellow-400 text-black font-medium hover:bg-yellow-300 transition-colors"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "Copied!" : "Copy MD"}
                </button>
                <button
                  onClick={reset}
                  className="text-sm px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors text-white/60"
                >
                  New file
                </button>
              </div>
            </div>

            {/* Markdown output */}
            <pre className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 text-sm text-white/80 overflow-auto max-h-[60vh] whitespace-pre-wrap font-mono leading-relaxed">
              {markdown}
            </pre>
          </div>
        )}

        {/* Features */}
        <div className="mt-16 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm text-white/50">
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
    </main>
  );
}
