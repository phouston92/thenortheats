"use client";
import React, { useState, useEffect } from "react";
import {
  Login,
  useSession,
  Empty,
  Status,
  ErrorMessage,
  money,
} from "../../../packages/ui/src/index";
import { api } from "../../../packages/ui/src/api";
export default function Home() {
  const { user, setUser } = useSession();
  const [page, setPage] = useState("discover");
  const [towns, setTowns] = useState<any[]>([]);
  const [town, setTown] = useState("Lancaster");
  const [partners, setPartners] = useState<any[]>([]);
  const [menu, setMenu] = useState<any>(null);
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [fulfilment, setFulfilment] = useState("collection");
  const [order, setOrder] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [orderId, setOrderId] = useState("");
  const [tickets, setTickets] = useState<any[]>([]);
  const [requestKey, setRequestKey] = useState("");
  useEffect(() => {
    api("/towns")
      .then(setTowns)
      .catch((e) => setError(e.message));
    const saved = localStorage.getItem("north-last-order");
    if (saved) setOrderId(saved);
  }, []);
  useEffect(() => {
    setError("");
    api("/partners?town=" + encodeURIComponent(town))
      .then(setPartners)
      .catch((e) => setError(e.message));
  }, [town]);
  useEffect(() => {
    if (page !== "tracking" || !orderId) return;
    const load = () =>
      api("/orders/" + orderId, {
        headers: localStorage.getItem("north-order-" + orderId)
          ? { "x-order-token": localStorage.getItem("north-order-" + orderId)! }
          : {},
      })
        .then(setOrder)
        .catch((e) => setError(e.message));
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [page, orderId]);
  async function showMenu(id: string) {
    setError("");
    try {
      setMenu(await api("/partners/" + id + "/menu"));
      setBasket({});
      setRequestKey(crypto.randomUUID());
      setPage("menu");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const items = menu?.products.filter((p: any) => basket[p.id] > 0) || [];
  const subtotal = items.reduce(
    (s: number, p: any) => s + p.price * basket[p.id],
    0,
  );
  const total =
    subtotal +
    (menu?.serviceFee || 0) +
    (fulfilment === "delivery" ? menu?.partner.delivery_fee || 0 : 0);
  function qty(id: string, delta: number) {
    setBasket((b) => ({
      ...b,
      [id]: Math.min(50, Math.max(0, (b[id] || 0) + delta)),
    }));
    setRequestKey(crypto.randomUUID());
  }
  async function checkout(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      // Keep a stable capability and key on retry, so a dropped response cannot duplicate the order.
      let token = sessionStorage.getItem("north-checkout-" + requestKey);
      if (!token) {
        token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");
        sessionStorage.setItem("north-checkout-" + requestKey, token);
      }
      const result = await api("/orders", {
        method: "POST",
        headers: { "idempotency-key": requestKey, "x-order-token": token },
        body: JSON.stringify({
          partnerId: menu.partner.id,
          items: items.map((p: any) => ({
            productId: p.id,
            quantity: basket[p.id],
          })),
          customerName: f.get("name"),
          customerEmail: f.get("email"),
          fulfilment,
          paymentMethod: "cash",
          address:
            fulfilment === "delivery"
              ? { line1: f.get("address"), postcode: f.get("postcode") }
              : undefined,
        }),
      });
      localStorage.setItem("north-order-" + result.id, token);
      localStorage.setItem("north-last-order", result.id);
      setOrderId(result.id);
      setOrder(null);
      setBasket({});
      setPage("tracking");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function account() {
    setError("");
    if (!user) {
      setPage("login");
      return;
    }
    try {
      setHistory(await api("/account/orders"));
      setPage("account");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (page === "login")
    return (
      <>
        <button className="quiet" onClick={() => setPage("discover")}>
          ← Back to takeaways
        </button>
        <Login
          title="Good food. Your way."
          onLogin={(u) => {
            setUser(u);
            setPage("discover");
          }}
        />
      </>
    );
  return (
    <>
      <header className="customer-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <div>
            <strong>THE NORTH EATS</strong>
            <small>Independent food. Local favourites.</small>
          </div>
        </div>
        <div className="head-buttons">
          <button
            className="quiet"
            style={{ color: "#fff" }}
            onClick={() => setPage("discover")}
          >
            Explore
          </button>
          {orderId && (
            <button
              className="quiet"
              style={{ color: "#fff" }}
              onClick={() => setPage("tracking")}
            >
              Track order
            </button>
          )}
          <button onClick={() => void account()}>
            {user ? "My account" : "Sign in"}
          </button>
        </div>
      </header>
      <main className="customer-main">
        <ErrorMessage error={error} />
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {page === "discover" && (
          <>
            <section className="hero">
              <span className="eyebrow">
                BIG FLAVOUR. RIGHT ON YOUR DOORSTEP.
              </span>
              <h1>
                Your town.
                <br />
                Your takeaways.
                <br />
                <span style={{ color: "#a23b00" }}>Your next favourite.</span>
              </h1>
              <p>
                Discover the independent kitchens that make your neighbourhood
                taste so good.
              </p>
              <label>
                Where are we eating?
                <select value={town} onChange={(e) => setTown(e.target.value)}>
                  {towns.map((t) => (
                    <option key={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>
            </section>
            <div className="page-head">
              <div>
                <h2>Local favourites in {town}</h2>
                <p>Good food from independent businesses.</p>
              </div>
              <small>{partners.length} takeaways available</small>
            </div>
            {partners.length ? (
              <div className="restaurant-grid">
                {partners.map((p) => (
                  <article className="restaurant-card" key={p.id}>
                    <div className="food-art" aria-hidden="true">
                      ✦
                    </div>
                    <div className="panel-body">
                      <span className="eyebrow">INDEPENDENT & LOCAL</span>
                      <h2 style={{ marginTop: 10 }}>{p.name}</h2>
                      <p>
                        {p.town} · {p.preparation_minutes} min preparation
                        <br />
                        {p.collection ? "Collection available · " : ""}
                        {money(p.delivery_fee)} delivery
                      </p>
                      <button onClick={() => void showMenu(p.id)}>
                        Explore menu →
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <section className="panel">
                <Empty
                  title="Something good is on its way"
                  detail={`No takeaways are accepting orders in ${town} right now. Try another town or check back soon.`}
                />
              </section>
            )}
            <p className="notice">
              Development ordering only. Cash checkout is available for approved
              partners. Online card checkout is not yet enabled in this
              interface.
            </p>
          </>
        )}
        {["menu", "checkout"].includes(page) && menu && (
          <>
            <button
              className="quiet"
              onClick={() => setPage(page === "checkout" ? "menu" : "discover")}
            >
              ← {page === "checkout" ? "Back to menu" : "All takeaways"}
            </button>
            <div className="menu-heading">
              <h1>
                {page === "checkout"
                  ? "Your order, nearly ready."
                  : menu.partner.name}
              </h1>
              <p>
                {page === "checkout"
                  ? "Check your details and fees before placing your cash order."
                  : "Prepared locally. Made to be enjoyed."}
              </p>
            </div>
            <div className="customer-columns">
              <div>
                {page === "menu" ? (
                  <section className="panel">
                    {menu.products.map((p: any) => (
                      <article className="product" key={p.id}>
                        <div>
                          <span className="eyebrow">{p.category}</span>
                          <h3 style={{ marginTop: 8 }}>{p.name}</h3>
                          <p>{p.description}</p>
                          <strong>{money(p.price)}</strong>
                          <p>
                            <small>
                              Allergens:{" "}
                              {p.allergens.join(", ") ||
                                "Contact the takeaway for allergen information."}
                            </small>
                          </p>
                        </div>
                        <button
                          aria-label={"Add " + p.name}
                          disabled={!p.available}
                          onClick={() => qty(p.id, 1)}
                        >
                          {p.available ? "+ Add" : "Sold out"}
                        </button>
                      </article>
                    ))}
                  </section>
                ) : (
                  <section className="panel">
                    <div className="panel-body">
                      <form onSubmit={checkout}>
                        <h2>Your details</h2>
                        <p>Guest checkout is welcome.</p>
                        <label>
                          Full name
                          <input
                            name="name"
                            autoComplete="name"
                            required
                            minLength={2}
                          />
                        </label>
                        <label>
                          Email address
                          <input
                            name="email"
                            type="email"
                            autoComplete="email"
                            defaultValue={user?.email || ""}
                            required
                          />
                        </label>
                        <label>
                          How would you like your food?
                          <select
                            aria-label="Fulfilment"
                            value={fulfilment}
                            onChange={(e) => {
                              setFulfilment(e.target.value);
                              setRequestKey(crypto.randomUUID());
                            }}
                          >
                            <option value="collection">Collection</option>
                            <option value="delivery">Delivery</option>
                          </select>
                        </label>
                        {fulfilment === "delivery" && (
                          <>
                            <label>
                              Address
                              <input
                                name="address"
                                autoComplete="street-address"
                                required
                                minLength={3}
                              />
                            </label>
                            <label>
                              Postcode
                              <input
                                name="postcode"
                                autoComplete="postal-code"
                                required
                              />
                            </label>
                          </>
                        )}
                        <label>
                          Payment method
                          <select name="payment">
                            <option>Cash · pay the takeaway directly</option>
                          </select>
                        </label>
                        <p className="notice">
                          Immediate orders only. Collection/delivery acceptance
                          is confirmed by the takeaway. The separate customer
                          service fee belongs to The North Eats and is included
                          in the cash total paid to the takeaway.
                        </p>
                        <label className="check">
                          <input type="checkbox" required />I have checked
                          allergens directly with the takeaway where needed.
                        </label>
                        <button disabled={busy || !items.length}>
                          {busy
                            ? "Placing order…"
                            : `Place cash order · ${money(total)}`}
                        </button>
                      </form>
                    </div>
                  </section>
                )}
              </div>
              <aside>
                <section className="panel">
                  <div className="panel-head">
                    <h2>Your basket</h2>
                    <small>{menu.partner.name}</small>
                  </div>
                  <div className="panel-body">
                    {items.length ? (
                      items.map((p: any) => (
                        <div key={p.id} className="basket-row">
                          <span>
                            {basket[p.id]} × {p.name}
                            <br />
                            <small>{money(p.price * basket[p.id])}</small>
                          </span>
                          <span>
                            <button
                              aria-label={"Remove " + p.name}
                              className="secondary"
                              onClick={() => qty(p.id, -1)}
                            >
                              −
                            </button>{" "}
                            <button
                              aria-label={"Increase " + p.name}
                              className="secondary"
                              onClick={() => qty(p.id, 1)}
                            >
                              +
                            </button>
                          </span>
                        </div>
                      ))
                    ) : (
                      <p>Your next favourite is a few taps away.</p>
                    )}
                    <div className="basket-total">
                      <div className="basket-row">
                        <span>Food subtotal</span>
                        <span>{money(subtotal)}</span>
                      </div>
                      <div className="basket-row">
                        <span>Customer service fee</span>
                        <span>{money(menu.serviceFee)}</span>
                      </div>
                      {fulfilment === "delivery" && (
                        <div className="basket-row">
                          <span>Delivery</span>
                          <span>{money(menu.partner.delivery_fee)}</span>
                        </div>
                      )}
                      <div className="basket-row">
                        <strong>Total</strong>
                        <strong>{money(total)}</strong>
                      </div>
                    </div>
                    {page === "menu" && (
                      <button
                        disabled={!items.length}
                        style={{ width: "100%" }}
                        onClick={() => setPage("checkout")}
                      >
                        Review checkout →
                      </button>
                    )}
                  </div>
                </section>
              </aside>
            </div>
          </>
        )}
        {page === "tracking" && (
          <section className="panel">
            <div className="panel-body">
              {order ? (
                <>
                  <span className="eyebrow">THANK YOU FOR ORDERING LOCAL</span>
                  <h1 style={{ marginTop: 12 }}>We’ve got your order.</h1>
                  <p>
                    Order #{order.id.slice(0, 8).toUpperCase()} ·{" "}
                    {money(order.total)}
                  </p>
                  <Status value={order.status} />
                  <p>
                    Payment:{" "}
                    {order.payment_state === "pending"
                      ? "Cash due to the takeaway"
                      : order.payment_state.replaceAll("_", " ")}
                  </p>
                  {order.items.map((i: any) => (
                    <p key={i.name}>
                      {i.quantity} × {i.name} ·{" "}
                      {money(i.unit_price * i.quantity)}
                    </p>
                  ))}
                  <h2>Follow your food</h2>
                  {order.history.map((h: any, i: number) => (
                    <div className="tracking-step" key={i}>
                      <Status value={h.status} />
                      <small>
                        {new Date(h.created_at).toLocaleString("en-GB")}
                      </small>
                    </div>
                  ))}
                  <p>
                    <small>
                      Status refreshes every 4 seconds. Keep this browser to
                      retain your guest tracking link.
                    </small>
                  </p>
                  <button
                    className="secondary"
                    onClick={() => setPage("discover")}
                  >
                    Explore more local food
                  </button>
                </>
              ) : (
                <p role="status">Loading your order…</p>
              )}
            </div>
          </section>
        )}
        {page === "account" && (
          <>
            <div className="page-head">
              <div>
                <h1>Your corner of The North Eats</h1>
                <p>{user?.email}</p>
              </div>
              <button
                className="secondary"
                onClick={async () => {
                  await api("/auth/logout", { method: "POST" });
                  setUser(null);
                  setPage("discover");
                }}
              >
                Sign out
              </button>
            </div>
            <section className="panel">
              <div className="panel-head">
                <h2>Order history</h2>
              </div>
              {history.length ? (
                <div className="panel-body">
                  {history.map((o) => (
                    <div className="basket-row" key={o.id}>
                      <span>
                        #{o.id.slice(0, 8)} · {money(o.total)}{" "}
                        <Status value={o.status} />
                      </span>
                      <button
                        className="secondary"
                        onClick={() => {
                          setOrderId(o.id);
                          setPage("tracking");
                        }}
                      >
                        Track
                      </button>
                      <button
                        className="secondary"
                        onClick={() => void showMenu(o.partner_id)}
                      >
                        Order again
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty
                  title="Your story starts with a first bite"
                  detail="Orders placed while signed in appear here."
                />
              )}
            </section>
            <section className="panel">
              <div className="panel-body">
                <h2>Need a hand?</h2>
                <form
                  className="support-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await api("/support", {
                        method: "POST",
                        body: JSON.stringify({
                          subject: new FormData(e.currentTarget).get("subject"),
                        }),
                      });
                      setTickets(await api("/support"));
                      setNotice("Your support ticket has been opened.");
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <input
                    name="subject"
                    aria-label="Support subject"
                    placeholder="Tell us what you need help with"
                    required
                    minLength={3}
                  />
                  <button>Contact support</button>
                </form>
                {tickets.map((t) => (
                  <p key={t.id}>
                    {t.subject} · {t.status}
                  </p>
                ))}
                <p>
                  <small>
                    Saved addresses and automatic basket reordering are planned.
                  </small>
                </p>
              </div>
            </section>
          </>
        )}
      </main>
      <footer className="customer-main">
        <small>
          © {new Date().getFullYear()} The North Eats · Good food. Independent
          businesses. Local people.
        </small>
      </footer>
    </>
  );
}
