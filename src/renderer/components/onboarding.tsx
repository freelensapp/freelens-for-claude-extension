/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { useState } from "react";
import styles from "./onboarding.module.scss";

import type { StatusResponse } from "../../common/protocol";

interface OnboardingProps {
  status: StatusResponse;
  onRecheck: () => Promise<void>;
}

const INSTALL_URL = "https://code.claude.com";

/** Shown when Claude Code is not detected on the machine. */
export function Onboarding({ status, onRecheck }: OnboardingProps) {
  const [checking, setChecking] = useState(false);

  const recheck = async () => {
    setChecking(true);
    try {
      await onRecheck();
    } finally {
      setChecking(false);
    }
  };

  const openInstall = (event: React.MouseEvent) => {
    event.preventDefault();
    window.open(INSTALL_URL, "_blank", "noopener,noreferrer");
  };

  return (
    <div className={styles.onboarding}>
      <div className={styles.card}>
        <h2>Claude Code is required</h2>
        <p>
          This extension is a frontend to your own Claude Code installation. It does not handle any credentials: sign-in
          is whatever you configured in Claude Code.
        </p>

        <h3>What we checked</h3>
        <ul className={styles.checks}>
          <li>
            <code>CLAUDE_CODE_PATH</code> environment variable
          </li>
          <li>
            <code>claude</code> on your <code>PATH</code>
          </li>
          <li>well-known install locations</li>
        </ul>
        {status.claudeCode.error ? <p className={styles.error}>{status.claudeCode.error}</p> : null}

        <h3>How to install</h3>
        <p>
          Install Claude Code, then run <code>claude</code> once in a terminal to log in. See{" "}
          <a href={INSTALL_URL} onClick={openInstall}>
            {INSTALL_URL}
          </a>
          .
        </p>

        <button type="button" className={styles.button} onClick={recheck} disabled={checking}>
          {checking ? "Checking..." : "Check again"}
        </button>
      </div>
    </div>
  );
}
