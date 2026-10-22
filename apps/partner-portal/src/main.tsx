import React, { useEffect, useState, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Store,
  ShoppingBag,
  UtensilsCrossed,
  Wallet,
  Settings,
  Headphones,
  Menu,
  LayoutDashboard,
  Users,
  Clock,
} from "lucide-react";
import {
  Login,
  useSession,
  Empty,
  Status,
  ErrorMessage,
  money,
} from "../../../packages/ui/src/index";
import { api } from "../../../packages/ui/src/api";
import "../../../packages/ui/src/styles.css";
function App() {
  const { user, setUser } = useSession();
  const [page, setPage] = useState("Orders");
  const [partner, setPartner] = useState<any>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [finance, setFinance] = useState<any>(null);
  const [tickets, setTickets] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const [newOrder, setNewOrder] = useState(false);
  const known = useRef<Set<string> | null>(null);
  const [partnerId, setPartnerId] = useState("");
  useEffect(() => {
    if (user?.partners?.length) setPartnerId(user.partners[0]);
  }, [user]);
  const load = useCallback(async () => {
    if (!partnerId) return;
    try {
      const [p, o, items] = await Promise.all([
        api("/partner/" + partnerId),
        api(`/partner/${partnerId}/orders`),
        api(`/partner/${partnerId}/products`),
      ]);
      const incoming = o.filter((x: any) => x.status === "awaiting_acceptance");
      if (
        known.current &&
        incoming.some((x: any) => !known.current!.has(x.id))
      ) {
        setNewOrder(true);
        if ("Notification" in window && Notification.permission === "granted")
          new Notification("New order · The North Eats", {
            body: "An order is waiting for acceptance.",
          });
      }
      known.current = new Set(o.map((x: any) => x.id));
      setPartner(p);
      setOrders(o);
      setProducts(items);
      if (page === "Finance")
        setFinance(await api(`/partner/${partnerId}/finance`));
      if (page === "Support") setTickets(await api("/support"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [partnerId, page]);
  useEffect(() => {
    known.current = null;
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);
  async function action(path: string, body: any, method = "POST") {
    setError("");
    try {
      await api(path, { method, body: JSON.stringify(body) });
      await load();
      setNotice("Changes saved.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (user === undefined) return <p role="status">Loading…</p>;
  if (!user) return <Login title="Your partner workspace" onLogin={setUser} />;
  if (!["owner", "operator"].includes(user.role))
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1>Partner access required</h1>
          <p>
            Your account must be assigned to a business by a platform
            administrator.
          </p>
          <button
            onClick={async () => {
              await api("/auth/logout", { method: "POST" });
              setUser(null);
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <UtensilsCrossed size={24} />
          </span>
          <div>
            <strong>THE NORTH EATS</strong>
            <small>Partner workspace</small>
          </div>
        </div>
        <div className="top-actions">
          <span className="dev-badge">DEVELOPMENT</span>
          <span>{partner?.name || "Your business"}</span>
          <button
            className="mobile-toggle quiet"
            aria-label="Toggle navigation"
            onClick={() => setOpen(!open)}
          >
            <Menu color="white" />
          </button>
        </div>
      </header>
      <aside className={"sidebar " + (open ? "open" : "")}>
        <div className="nav-label">YOUR BUSINESS</div>
        <nav>
          {[
            ["Dashboard", LayoutDashboard],
            ["Orders", ShoppingBag],
            ["Menu", UtensilsCrossed],
            ["Finance", Wallet],
            ["Settings", Settings],
            ["Staff", Users],
            ["Support", Headphones],
          ]
            .filter(([n]) => n !== "Finance" || user.role === "owner")
            .map(([n, Icon]) => {
              const I = Icon as typeof Store;
              return (
                <button
                  key={String(n)}
                  className={page === n ? "active" : ""}
                  onClick={() => {
                    setPage(String(n));
                    setOpen(false);
                    setNotice("");
                  }}
                >
                  <I />
                  {String(n)}
                </button>
              );
            })}
        </nav>
        <div className="sidebar-footer">
          Signed in as {user.role}
          <button
            onClick={async () => {
              await api("/auth/logout", { method: "POST" });
              setUser(null);
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="workspace">
        <div className="breadcrumbs">Partner workspace / {page}</div>
        <div className="page-head">
          <div>
            <h1>{page === "Dashboard" ? "Your business at a glance" : page}</h1>
            <p>
              {partner?.name} · {partner?.status || "Loading business"}
            </p>
          </div>
          {user.partners.length > 1 && (
            <label>
              Business
              <select
                aria-label="Business"
                value={partnerId}
                onChange={(e) => setPartnerId(e.target.value)}
              >
                {user.partners.map((p: string) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <ErrorMessage error={error} />
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {newOrder && (
          <div role="alert" className="notice">
            <strong>New order waiting for acceptance.</strong>{" "}
            <button
              onClick={() => {
                setPage("Orders");
                setNewOrder(false);
              }}
            >
              View orders
            </button>
          </div>
        )}
        {partner?.paused && (
          <p className="notice">
            Ordering is paused. Existing orders can still be fulfilled.
          </p>
        )}
        {page === "Dashboard" && (
          <>
            <div className="metrics">
              {[
                [
                  "Waiting for acceptance",
                  orders.filter((o) => o.status === "awaiting_acceptance")
                    .length,
                ],
                [
                  "In preparation",
                  orders.filter((o) =>
                    ["accepted", "preparing"].includes(o.status),
                  ).length,
                ],
                [
                  "Completed orders",
                  orders.filter((o) => o.status === "completed").length,
                ],
                [
                  "Preparation time",
                  `${partner?.preparation_minutes || 0} min`,
                ],
              ].map(([n, v]) => (
                <article className="metric" key={n}>
                  <div className="metric-top">
                    {n}
                    <Clock size={16} />
                  </div>
                  <div className="metric-value">{v}</div>
                </article>
              ))}
            </div>
            <section className="panel">
              <Empty
                title="Make every order a local favourite"
                detail="Open Orders to manage your incoming and active orders."
              />
            </section>
          </>
        )}
        {page === "Orders" && (
          <>
            <div className="toolbar">
              <button className="secondary" onClick={() => void load()}>
                Refresh orders
              </button>
              <button
                className="secondary"
                onClick={async () => {
                  if ("Notification" in window) {
                    const p = await Notification.requestPermission();
                    setNotice(
                      p === "granted"
                        ? "Browser notifications enabled."
                        : "In-app alerts remain enabled.",
                    );
                  } else
                    setNotice(
                      "In-app alerts are enabled; browser notifications are unavailable.",
                    );
                }}
              >
                Enable browser alerts
              </button>
              <small>Refreshes every 5 seconds</small>
            </div>
            <section className="panel">
              {orders.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th>Customer</th>
                        <th>Type</th>
                        <th>Payment</th>
                        <th>Status</th>
                        <th>Next step</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((o) => {
                        const next: Record<string, string> = {
                          awaiting_acceptance: "accepted",
                          accepted: "preparing",
                          preparing:
                            o.fulfilment === "delivery"
                              ? "out_for_delivery"
                              : "ready",
                          ready: "completed",
                          out_for_delivery: "completed",
                        };
                        return (
                          <tr key={o.id}>
                            <td>
                              #{o.id.slice(0, 8)}
                              <small>{money(o.total)}</small>
                            </td>
                            <td>{o.customer_name}</td>
                            <td>{o.fulfilment}</td>
                            <td>
                              {o.payment_method}
                              <small>{o.payment_state}</small>
                            </td>
                            <td>
                              <Status value={o.status} />
                            </td>
                            <td>
                              <div className="row-actions">
                                {next[o.status] && (
                                  <button
                                    onClick={() =>
                                      void action(
                                        `/partner/${partnerId}/orders/${o.id}/transition`,
                                        { status: next[o.status] },
                                      )
                                    }
                                  >
                                    {
                                      (
                                        {
                                          accepted: "Accept",
                                          preparing: "Start preparing",
                                          ready: "Ready for collection",
                                          out_for_delivery: "Out for delivery",
                                          completed: "Complete",
                                        } as any
                                      )[next[o.status]]
                                    }
                                  </button>
                                )}
                                {o.status === "awaiting_acceptance" && (
                                  <button
                                    className="secondary"
                                    onClick={() => {
                                      const reason = window.prompt(
                                        "Reason for rejection",
                                      );
                                      if (reason)
                                        void action(
                                          `/partner/${partnerId}/orders/${o.id}/transition`,
                                          { status: "rejected", reason },
                                        );
                                    }}
                                  >
                                    Reject
                                  </button>
                                )}
                                <button
                                  className="secondary"
                                  onClick={async () => {
                                    const detail = await api("/orders/" + o.id);
                                    setNotice(
                                      detail.items
                                        .map(
                                          (i: any) =>
                                            `${i.quantity} × ${i.name}`,
                                        )
                                        .join(" · "),
                                    );
                                  }}
                                >
                                  Items
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="Ready for your first order"
                  detail="Incoming cash and paid card orders will appear here."
                />
              )}
            </section>
          </>
        )}
        {page === "Menu" && (
          <>
            {user.role === "owner" && (
              <section className="panel form-panel">
                <div className="panel-body">
                  <h2>Add a product</h2>
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const f = e.currentTarget;
                      const v = Object.fromEntries(new FormData(f));
                      await action(`/partner/${partnerId}/products`, {
                        name: v.name,
                        category: v.category,
                        description: v.description,
                        price: Number(v.price),
                        allergens: String(v.allergens)
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean),
                      });
                      f.reset();
                    }}
                  >
                    <div className="split-form">
                      <label>
                        Name
                        <input name="name" required minLength={2} />
                      </label>
                      <label>
                        Category
                        <input name="category" required minLength={2} />
                      </label>
                      <label>
                        Price (pence)
                        <input name="price" type="number" min="1" required />
                      </label>
                      <label>
                        Allergens (comma separated)
                        <input name="allergens" />
                      </label>
                    </div>
                    <label>
                      Description
                      <textarea name="description" />
                    </label>
                    <button>Add product</button>
                  </form>
                </div>
              </section>
            )}
            <section className="panel">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Category</th>
                      <th>Price</th>
                      <th>Availability</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p) => (
                      <tr key={p.id}>
                        <td>
                          {p.name}
                          <small>{p.allergens.join(", ")}</small>
                        </td>
                        <td>{p.category}</td>
                        <td>{money(p.price)}</td>
                        <td>
                          <button
                            className="secondary"
                            onClick={() =>
                              void action(
                                `/partner/${partnerId}/products/${p.id}`,
                                { available: !p.available },
                                "PATCH",
                              )
                            }
                          >
                            {p.available ? "Mark sold out" : "Make available"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <p className="notice">
              Variants, modifier groups and menu scheduling are not implemented.
            </p>
          </>
        )}
        {page === "Finance" && finance && (
          <section className="panel">
            <div className="panel-body">
              <h2>Weekly draft invoices</h2>
              <p>Automatic collection is disabled.</p>
              {finance.invoices.length ? (
                finance.invoices.map((i: any) => (
                  <p key={i.id}>
                    {i.number} · {money(i.total)} · <Status value={i.status} />
                  </p>
                ))
              ) : (
                <Empty
                  title="No invoices yet"
                  detail="Platform administrators generate draft invoices for closed billing weeks."
                />
              )}
              <h2>Fee ledger</h2>
              {finance.ledger.map((l: any) => (
                <p key={l.id}>
                  {l.kind.replaceAll("_", " ")} · {money(l.amount)}{" "}
                  <small>{l.reference}</small>
                </p>
              ))}
            </div>
          </section>
        )}
        {page === "Settings" && partner && (
          <section className="panel form-panel">
            <div className="panel-body">
              <h2>Ordering preferences</h2>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const v = new FormData(e.currentTarget);
                  await action(
                    `/partner/${partnerId}/settings`,
                    {
                      paused: v.get("paused") === "on",
                      preparationMinutes: Number(v.get("prep")),
                    },
                    "PATCH",
                  );
                }}
                key={String(partner.paused) + partner.preparation_minutes}
              >
                <label>
                  Preparation time (minutes)
                  <input
                    type="number"
                    name="prep"
                    min="5"
                    max="180"
                    defaultValue={partner.preparation_minutes}
                    required
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    name="paused"
                    defaultChecked={partner.paused}
                  />
                  Pause new orders
                </label>
                <button>Save settings</button>
              </form>
              <p className="notice">
                Opening hours, exceptional closures and self-service delivery
                boundaries are not implemented. Current delivery outward
                postcodes: {partner.delivery_postcodes.join(", ") || "none"}.
              </p>
            </div>
          </section>
        )}
        {page === "Staff" && (
          <section className="panel">
            <Empty
              title="Staff assignments"
              detail="Ask a platform administrator to add an operator or owner to your business. Self-service staff management is planned."
            />
          </section>
        )}
        {page === "Support" && (
          <section className="panel">
            <div className="panel-body">
              <h2>Talk to The North Eats</h2>
              <form
                className="support-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = e.currentTarget;
                  await action("/support", {
                    subject: new FormData(f).get("subject"),
                    partnerId,
                  });
                  f.reset();
                }}
              >
                <input
                  name="subject"
                  aria-label="Ticket subject"
                  placeholder="How can we help?"
                  required
                  minLength={3}
                />
                <button>Open ticket</button>
              </form>
              {tickets
                .filter((t) => t.partner_id === partnerId)
                .map((t) => (
                  <p key={t.id}>
                    {t.subject} · <Status value={t.status} />
                  </p>
                ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
