"use client";

import * as React from "react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { MAGIC_LINK_MESSAGES, SIGN_IN_METHOD_NOTE, type AuthMessage } from "@/lib/auth/auth-copy";
import { RETURN_PATH_PARAM } from "@/lib/auth/return-path";
import {
  INITIAL_MAGIC_LINK_STATE,
  requestMagicLinkAction,
  startGoogleSignInAction,
} from "./actions";

/**
 * Sign-in form (ATL-014).
 *
 * Client component because it owns submission state. The work happens in Server
 * Actions — no Supabase call is made from the browser, so no credential reaches
 * the bundle.
 *
 * Accessibility decisions that carry weight:
 *   - The result is announced through a live region and focused when it arrives,
 *     so a screen-reader user learns the outcome without hunting for it.
 *   - `invalid_email` is a *field* error: it sets `aria-invalid`, is referenced by
 *     `aria-describedby`, and moves focus back to the input, because the fix is in
 *     the field. Every other code is a form-level message — the address was fine
 *     and refocusing it would be misleading.
 *   - The submit button is disabled while pending and says so, rather than
 *     silently swallowing a second press.
 */

export interface SignInFormProps {
  /** Validated return path forwarded through the round trip. */
  returnPath?: string | undefined;
  /** Whether to offer Google. Optional per security §5. */
  googleEnabled?: boolean;
}

const TONE_STYLES: Record<AuthMessage["tone"], string> = {
  info: "border-border-default bg-surface-subtle",
  success: "border-success/40 bg-success/10",
  warning: "border-warning/40 bg-warning/10",
};

export function SignInForm({ returnPath, googleEnabled = false }: SignInFormProps) {
  const [state, formAction, isPending] = useActionState(
    requestMagicLinkAction,
    INITIAL_MAGIC_LINK_STATE,
  );

  const messageRef = React.useRef<HTMLDivElement>(null);
  const emailRef = React.useRef<HTMLInputElement>(null);
  const descriptionId = React.useId();
  const messageId = React.useId();

  const message = state.code ? MAGIC_LINK_MESSAGES[state.code] : null;
  const isFieldError = state.code === "invalid_email";

  /**
   * Move focus to wherever the fix is.
   *
   * Keyed on `attempt` rather than `code` so a repeated identical result still
   * announces — submitting the same bad address twice must not go unremarked.
   */
  React.useEffect(() => {
    if (state.attempt === 0) return;
    if (isFieldError) emailRef.current?.focus();
    else messageRef.current?.focus();
  }, [state.attempt, isFieldError]);

  return (
    <div className="flex flex-col gap-6">
      {/**
       * The result region.
       *
       * `role="status"` carries an implicit polite live region, so the outcome is
       * announced without an assertive interruption. It is rendered
       * unconditionally — a live region inserted at the same moment as its
       * content is announced unreliably — and `tabIndex={-1}` makes it a focus
       * target for form-level results.
       */}
      <div
        ref={messageRef}
        role="status"
        tabIndex={-1}
        id={messageId}
        data-slot="sign-in-message"
        data-tone={message?.tone}
        className={cn(
          "outline-none",
          message && "flex flex-col gap-1 rounded-card border px-4 py-3",
          message && TONE_STYLES[message.tone],
        )}
      >
        {message && (
          <>
            <p className="text-body-sm font-medium">{message.title}</p>
            <p className="text-body-sm text-text-secondary">{message.description}</p>
          </>
        )}
      </div>

      <form action={formAction} className="flex flex-col gap-4" noValidate>
        {/* Carried as a hidden field so it survives the POST without appearing in
            a URL. Already validated on the server before it reaches the page, and
            validated again in the action. */}
        {returnPath && (
          <input
            type="hidden"
            data-testid="return-path"
            name={RETURN_PATH_PARAM}
            value={returnPath}
          />
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email address</Label>
          <Input
            ref={emailRef}
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            // Not `required`: browser-native validation messages are not styled,
            // not announced consistently, and would pre-empt the neutral copy.
            // `noValidate` on the form defers entirely to the server result.
            inputMode="email"
            /**
             * Deliberately not autofocused. The reason banner above explains why
             * the user was sent here — an expired link, or a session that ended —
             * and dropping focus into the field skips past it for exactly the
             * people who most need it read to them.
             */
            placeholder="you@example.com"
            state={isFieldError ? "error" : "default"}
            aria-describedby={isFieldError ? messageId : descriptionId}
            disabled={isPending}
          />
          <p id={descriptionId} className="text-body-sm text-text-secondary">
            {SIGN_IN_METHOD_NOTE}
          </p>
        </div>

        <Button type="submit" size="lg" loading={isPending} className="w-full">
          {isPending ? "Sending link" : "Email me a sign-in link"}
        </Button>
      </form>

      {googleEnabled && (
        <>
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px grow bg-border-default" />
            <span className="text-caption text-text-muted">or</span>
            <span className="h-px grow bg-border-default" />
          </div>

          {/* A separate form so Google is a real submission with its own action,
              not a button that hijacks the email form's state. */}
          <form action={startGoogleSignInAction}>
            {/* Distinct test id: both forms carry the field, and one shared id
                would make either unqueryable when Google is enabled. */}
            {returnPath && (
              <input
                type="hidden"
                data-testid="return-path-google"
                name={RETURN_PATH_PARAM}
                value={returnPath}
              />
            )}
            <Button type="submit" variant="secondary" size="lg" className="w-full">
              Continue with Google
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
