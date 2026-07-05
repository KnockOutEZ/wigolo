"use client";

import { useState } from "react";
import { FEEDBACK_LINKS } from "@/lib/site";
import styles from "./Feedback.module.css";

const WEB3FORMS_KEY = process.env.NEXT_PUBLIC_WEB3FORMS_KEY;

function QuickForm() {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  if (!WEB3FORMS_KEY) return null;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    data.append("access_key", WEB3FORMS_KEY!);
    data.append("subject", "wigolo site feedback");
    if (data.get("botcheck")) return;
    setState("sending");
    try {
      const res = await fetch("https://api.web3forms.com/submit", {
        method: "POST",
        body: data,
      });
      const json = await res.json();
      if (json.success) {
        setState("sent");
        form.reset();
      } else {
        setState("error");
      }
    } catch {
      setState("error");
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <input type="checkbox" name="botcheck" className={styles.honey} tabIndex={-1} autoComplete="off" />
      <label className={styles.label}>
        anything — a bug, a rough edge, an idea
        <textarea
          className={styles.textarea}
          name="message"
          required
          rows={4}
          maxLength={4000}
          placeholder="what happened, what you expected…"
        />
      </label>
      <label className={styles.label}>
        email — optional, only if you want a reply
        <input className={styles.input} type="email" name="email" placeholder="you@…" />
      </label>
      <div className={styles.formFoot}>
        <button className="btn btn-primary" type="submit" disabled={state === "sending"}>
          {state === "sending" ? "sending…" : state === "sent" ? "sent — thank you" : "send feedback"}
        </button>
        {state === "error" && (
          <span className={styles.err}>didn&apos;t go through — try a GitHub issue instead</span>
        )}
        <span className={styles.privacy}>no account needed · nothing else collected</span>
      </div>
    </form>
  );
}

export default function Feedback() {
  return (
    <section className={styles.section} id="feedback">
      <div className={`container ${styles.grid}`}>
        <div className={styles.head}>
          <span className="eyebrow">Public beta</span>
          <h2 className={styles.title}>
            Found something?
            <br />
            Say it.
          </h2>
          <p className={styles.lede}>
            wigolo is in public beta — everything shipped works, and it&apos;s
            held to a 6,000-test suite, but beta means the polish is still
            being sanded. Every report is read, usually the same day.
          </p>
          <div className={styles.ctas}>
            <a href={FEEDBACK_LINKS.bug} className="btn btn-primary" target="_blank" rel="noreferrer">
              Report a bug
            </a>
            <a href={FEEDBACK_LINKS.feature} className={styles.secondary} target="_blank" rel="noreferrer">
              Request a feature
            </a>
            <a href={FEEDBACK_LINKS.discussions} className={styles.secondary} target="_blank" rel="noreferrer">
              Ask a question
            </a>
          </div>
        </div>
        <QuickForm />
      </div>
    </section>
  );
}
