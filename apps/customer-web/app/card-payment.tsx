"use client";
import { useEffect, useRef, useState } from "react";
import {
  loadStripe,
  type Stripe,
  type StripeElements,
} from "@stripe/stripe-js";
export function CardPayment({
  payment,
  onDone,
  onError,
}: {
  payment: {
    id: string;
    clientSecret: string;
    stripeAccount: string;
    publishableKey: string;
  };
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const mount = useRef<HTMLDivElement>(null),
    stripe = useRef<Stripe | null>(null),
    elements = useRef<StripeElements | null>(null);
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let stopped = false;
    let destroy: (() => void) | undefined;
    void loadStripe(payment.publishableKey, {
      stripeAccount: payment.stripeAccount,
    })
      .then((s) => {
        if (stopped) return;
        if (!s) throw new Error("Stripe checkout unavailable");
        stripe.current = s;
        elements.current = s.elements({ clientSecret: payment.clientSecret });
        const element = elements.current.create("payment");
        destroy = () => element.destroy();
        element.on("ready", () => setReady(true));
        element.on("loaderror", () =>
          onError(
            "Stripe checkout could not load; your order can be retried safely.",
          ),
        );
        element.mount(mount.current!);
      })
      .catch((e) => onError((e as Error).message));
    return () => {
      stopped = true;
      destroy?.();
    };
  }, [payment, onError]);
  return (
    <section>
      <h2>Pay by card · Stripe test mode</h2>
      <p>
        Use Stripe test cards only. Payment status is confirmed by a signed
        webhook.
      </p>
      <div ref={mount} />
      <button
        disabled={!ready || busy}
        onClick={async () => {
          if (!stripe.current || !elements.current) return;
          setBusy(true);
          try {
            const result = await stripe.current.confirmPayment({
              elements: elements.current,
              confirmParams: {
                return_url:
                  window.location.origin +
                  "/?payment_return=" +
                  encodeURIComponent(payment.id),
              },
              redirect: "if_required",
            });
            if (result.error)
              onError(result.error.message || "Payment could not be confirmed");
            else onDone();
          } catch (e) {
            onError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Confirming…" : "Confirm test payment"}
      </button>
      <button className="quiet" onClick={onDone}>
        Track order status
      </button>
    </section>
  );
}
