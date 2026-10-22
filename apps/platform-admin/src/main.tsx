import { MfaManagement } from "./mfa-management";
import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  Store,
  Users,
  ShoppingBag,
  MapPin,
  Wallet,
  Receipt,
  Tag,
  Headphones,
  Plug,
  UserCog,
  ScrollText,
  Settings,
  Bell,
  ChevronRight,
  Plus,
  ArrowUpRight,
  Menu,
  UtensilsCrossed,
  RefreshCw,
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
const nav = [
  ["Dashboard", LayoutDashboard],
  ["Partners", Store],
  ["Customers", Users],
  ["Orders", ShoppingBag],
  ["Towns and Locations", MapPin],
  ["Finance", Wallet],
  ["Billing", Receipt],
  ["Promotions", Tag],
  ["Helpdesk", Headphones],
  ["Integrations", Plug],
  ["Users and Permissions", UserCog],
  ["Audit Logs", ScrollText],
  ["Platform Settings", Settings],
] as const;
function App() {
  const { user, setUser } = useSession();
  const [page, setPage] = useState("Dashboard");
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<any>(null);
  const [towns, setTowns] = useState<any[]>([]);
  const [partners, setPartners] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState("");
  const [selected, setSelected] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (user?.role !== "admin") return;
    setError("");
    try {
      const [t, p] = await Promise.all([api("/towns"), api("/admin/partners")]);
      setTowns(t);
      setPartners(p);
      const paths: Record<string, string> = {
        Dashboard: "/admin/summary",
        Partners: "/admin/partners",
        Customers: "/admin/customers",
        Orders: "/admin/orders",
        Finance: "/admin/finance",
        Billing: "/admin/finance",
        Helpdesk: "/support",
        Integrations: "/admin/integrations",
        "Audit Logs": "/admin/audit",
      };
      if (paths[page]) {
        const d = await api(paths[page]);
        if (page === "Dashboard") d.orders = await api("/admin/orders");
        setData(d);
      } else setData({});
    } catch (e) {
      setError((e as Error).message);
    }
  }, [user, page]);
  useEffect(() => {
    setData(null);
    setNotice("");
    void load();
  }, [load]);
  function navigate(p: string) {
    setPage(p);
    setForm("");
    setOpen(false);
    setSearch("");
    setSelected(null);
  }
  async function action(path: string, body: any, method = "POST") {
    setBusy(true);
    setError("");
    try {
      const result = await api(path, { method, body: JSON.stringify(body) });
      setNotice("Changes saved.");
      await load();
      return result;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget));
    let result;
    if (form === "partner")
      result = await action("/admin/partners", {
        name: v.name,
        townId: v.townId,
      });
    if (form === "town")
      result = await action("/admin/towns", { name: v.name });
    if (form === "staff")
      result = await action("/admin/staff", {
        email: v.email,
        role: v.role,
        partnerId: v.partnerId,
      });
    if (form === "ticket")
      result = await action("/support", { subject: v.subject });
    if (form === "invoice")
      result = await action("/admin/invoices", {
        partnerId: v.partnerId,
        periodStart: v.periodStart,
      });
    if (form === "pricing")
      result = await action(`/admin/partners/${selected.id}/pricing`, {
        fixedFee: Number(v.fixedFee),
        serviceFee: Number(v.serviceFee),
        basisPoints: Number(v.basisPoints),
        minimumFee: Number(v.minimumFee),
        maximumFee: v.maximumFee ? Number(v.maximumFee) : null,
        vatBasisPoints: Number(v.vatBasisPoints),
        taxConfirmed: v.taxConfirmed === "on",
      });
    if (result) setForm("");
  }
  if (user === undefined)
    return (
      <div className="login-wrap" role="status">
        Loading your workspace…
      </div>
    );
  if (!user) return <Login title="Platform administration" onLogin={setUser} />;
  if (user.role !== "admin")
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1>Access restricted</h1>
          <p>A platform administrator account with MFA is required.</p>
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
  const filtered = (Array.isArray(data) ? data : []).filter((r: any) =>
    JSON.stringify(r).toLowerCase().includes(search.toLowerCase()),
  );
  function orderTable(orders: any[]) {
    return orders.length ? (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Partner</th>
              <th>Payment</th>
              <th>Total</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>
                  <strong>#{o.id.slice(0, 8).toUpperCase()}</strong>
                  <small>
                    {new Date(o.created_at).toLocaleString("en-GB")}
                  </small>
                </td>
                <td>{o.partner}</td>
                <td>
                  <Status value={o.payment_method} />
                </td>
                <td>{money(o.total)}</td>
                <td>
                  <Status value={o.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty
        title="Your first order starts here"
        detail="Orders placed through The North Eats will appear here in real time."
      />
    );
  }
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <UtensilsCrossed size={23} />
          </div>
          <div>
            <strong>THE NORTH EATS</strong>
            <small>Platform administration</small>
          </div>
        </div>
        <div className="top-actions">
          <span className="dev-badge">DEVELOPMENT</span>
          <button
            className="quiet"
            aria-label="Refresh dashboard"
            onClick={() => void load()}
          >
            <Bell size={18} color="#d4d7de" />
          </button>
          <span className="account-email">{user.email}</span>
          <span className="avatar" aria-label="Administrator">
            {user.email[0].toUpperCase()}
          </span>
          <button
            className="quiet mobile-toggle"
            aria-label="Toggle navigation"
            onClick={() => setOpen(!open)}
          >
            <Menu color="white" size={20} />
          </button>
        </div>
      </header>
      <aside className={"sidebar " + (open ? "open" : "")}>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Administration">
          {nav.map(([label, Icon]) => (
            <button
              key={label}
              className={page === label ? "active" : ""}
              onClick={() => navigate(label)}
              aria-current={page === label ? "page" : undefined}
            >
              <Icon />
              {label}
              {["Promotions", "Platform Settings"].includes(label) && (
                <span className="nav-dot">PLANNED</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div>
            <span className="dot" />
            Development workspace
          </div>
          <div>The North Eats · v0.1</div>
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
        <div className="breadcrumbs">
          Workspace <span aria-hidden="true"> / </span> {page}
        </div>
        <div className="page-head">
          <div>
            <h1>{page === "Dashboard" ? "Platform overview" : page}</h1>
            <p>
              {page === "Dashboard"
                ? "A little local flavour. A clear view of your platform."
                : "Manage your local food community."}
            </p>
          </div>
          <div className="head-buttons">
            <button
              className="secondary"
              aria-label="Refresh data"
              onClick={() => void load()}
            >
              <RefreshCw size={13} /> Refresh
            </button>
            {["Dashboard", "Partners"].includes(page) && (
              <button
                onClick={() => {
                  setForm("partner");
                  setPage("Partners");
                }}
              >
                <Plus size={14} /> Add partner
              </button>
            )}
            {page === "Towns and Locations" && (
              <button onClick={() => setForm("town")}>Add town</button>
            )}
            {page === "Users and Permissions" && (
              <button onClick={() => setForm("staff")}>
                Add partner staff
              </button>
            )}
            {page === "Billing" && (
              <button onClick={() => setForm("invoice")}>
                Generate draft invoice
              </button>
            )}
            {page === "Helpdesk" && (
              <button onClick={() => setForm("ticket")}>New ticket</button>
            )}
          </div>
        </div>
        <ErrorMessage error={error} />
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {form && (
          <section className="panel form-panel">
            <div className="panel-body">
              <h2>
                {form === "pricing"
                  ? `Pricing · ${selected?.name}`
                  : form === "partner"
                    ? "Add a partner"
                    : form === "invoice"
                      ? "Generate weekly invoice"
                      : form === "staff"
                        ? "Assign partner staff"
                        : form === "town"
                          ? "Add a town"
                          : "Create ticket"}
              </h2>
              <form onSubmit={submit}>
                {["partner", "town"].includes(form) && (
                  <label>
                    Name
                    <input name="name" required minLength={2} />
                  </label>
                )}
                {form === "partner" && (
                  <label>
                    Town
                    <select name="townId">
                      {towns.map((t) => (
                        <option value={t.id} key={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {["staff", "invoice"].includes(form) && (
                  <label>
                    Partner
                    <select name="partnerId">
                      {partners.map((p) => (
                        <option value={p.id} key={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {form === "staff" && (
                  <>
                    <label>
                      Email
                      <input type="email" name="email" required />
                    </label>
                    <label>
                      Role
                      <select name="role">
                        <option value="operator">
                          Operational staff · no finance access
                        </option>
                        <option value="owner">
                          Business owner · finance access
                        </option>
                      </select>
                    </label>
                    <p className="notice">
                      Existing owner/operator roles are platform-wide for their
                      assigned businesses. Custom per-membership roles are not
                      implemented.
                    </p>
                  </>
                )}
                {form === "invoice" && (
                  <>
                    <label>
                      Period start (Monday, UTC)
                      <input name="periodStart" type="date" required />
                    </label>
                    <p className="notice">
                      Closed weeks only. This creates an immutable draft; no
                      payment is collected. VAT treatment requires accountant
                      approval before issue.
                    </p>
                  </>
                )}
                {form === "ticket" && (
                  <label>
                    Subject
                    <input name="subject" required minLength={3} />
                  </label>
                )}
                {form === "pricing" && (
                  <>
                    <p className="notice">
                      Explicit partner approval only. All amounts are integer
                      pence, rates are basis points. Tax values must be
                      confirmed by your accountant. Future subscription charging
                      is not enabled.
                    </p>
                    <div className="split-form">
                      {[
                        ["fixedFee", "Completed-order fee (pence)", 100],
                        ["serviceFee", "Customer service fee (pence)", 100],
                        ["basisPoints", "Commission (basis points)", 0],
                        ["minimumFee", "Minimum commission (pence)", 0],
                        ["maximumFee", "Maximum commission (optional)", ""],
                        ["vatBasisPoints", "VAT rate (basis points)", 0],
                      ].map(([name, label, value]) => (
                        <label key={name}>
                          {label}
                          <input
                            name={String(name)}
                            type="number"
                            min="0"
                            defaultValue={value}
                            required={name !== "maximumFee"}
                          />
                        </label>
                      ))}
                    </div>
                    <label className="check">
                      <input type="checkbox" name="taxConfirmed" />
                      Tax treatment confirmed by accountant
                    </label>
                  </>
                )}
                <button disabled={busy}>
                  Save {form === "pricing" ? "approved pricing" : ""}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setForm("")}
                >
                  Cancel
                </button>
              </form>
            </div>
          </section>
        )}
        {!data && !error ? (
          <p role="status">Loading live platform data…</p>
        ) : (
          <>
            {page === "Dashboard" && data && (
              <>
                <div className="metrics">
                  {[
                    [
                      "Active partners",
                      data.active_partners,
                      Store,
                      "Independent businesses on the platform",
                    ],
                    [
                      "Orders today",
                      data.orders_today,
                      ShoppingBag,
                      "Since midnight UTC",
                    ],
                    [
                      "Platform fees",
                      money(data.platform_revenue),
                      Wallet,
                      "Net accrued ledger fees · before VAT",
                    ],
                    [
                      "Pending approvals",
                      data.pending_partners,
                      UserCog,
                      "Partners waiting to get started",
                    ],
                  ].map(([title, value, Icon, detail]) => {
                    const I = Icon as typeof Store;
                    return (
                      <article className="metric" key={String(title)}>
                        <div className="metric-top">
                          <span>{String(title)}</span>
                          <span className="metric-icon">
                            <I />
                          </span>
                        </div>
                        <div className="metric-value">{String(value)}</div>
                        <small>{String(detail)}</small>
                      </article>
                    );
                  })}
                </div>
                <div className="dashboard-grid">
                  <div>
                    <section className="panel">
                      <div className="panel-head">
                        <div>
                          <h2>Recent orders</h2>
                          <small>
                            The latest activity across your partners
                          </small>
                        </div>
                        <button
                          className="quiet"
                          onClick={() => navigate("Orders")}
                        >
                          View all <ArrowUpRight size={12} />
                        </button>
                      </div>
                      {orderTable(data.orders?.slice(0, 6) || [])}
                    </section>
                    <section className="panel">
                      <div className="panel-head">
                        <div>
                          <h2>Partner onboarding</h2>
                          <small>
                            Help your next independent business get started
                          </small>
                        </div>
                        <Status value="pending" />
                      </div>
                      {partners.filter((p) => p.status === "pending").length ? (
                        <div className="table-wrap">
                          <table>
                            <tbody>
                              {partners
                                .filter((p) => p.status === "pending")
                                .slice(0, 3)
                                .map((p) => (
                                  <tr key={p.id}>
                                    <td>
                                      <strong>{p.name}</strong>
                                      <small>{p.town}</small>
                                    </td>
                                    <td>
                                      <Status
                                        value={
                                          p.pricing
                                            ? "Pricing approved"
                                            : "Pricing required"
                                        }
                                      />
                                    </td>
                                    <td>
                                      <button
                                        className="quiet"
                                        onClick={() => navigate("Partners")}
                                      >
                                        Review <ChevronRight size={12} />
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <Empty
                          title="All caught up"
                          detail="New partner applications will appear here."
                        />
                      )}
                    </section>
                  </div>
                  <div>
                    <section className="panel">
                      <div className="panel-head">
                        <h2>Quick actions</h2>
                      </div>
                      {[
                        [
                          "Add a new partner",
                          "Grow your local food community",
                          Store,
                          "Partners",
                        ],
                        [
                          "Review weekly billing",
                          "Keep your finances in order",
                          Receipt,
                          "Billing",
                        ],
                        [
                          "Open the helpdesk",
                          "A helping hand for your partners",
                          Headphones,
                          "Helpdesk",
                        ],
                      ].map(([title, detail, Icon, target]) => {
                        const I = Icon as typeof Store;
                        return (
                          <button
                            className="quick-action"
                            key={String(title)}
                            onClick={() => navigate(String(target))}
                          >
                            <I />
                            <span>
                              {String(title)}
                              <small>{String(detail)}</small>
                            </span>
                            <ChevronRight className="arrow" size={14} />
                          </button>
                        );
                      })}
                    </section>
                    <section className="panel">
                      <div className="panel-head">
                        <h2>Your towns</h2>
                        <MapPin size={15} color="#888" />
                      </div>
                      {towns.map((t) => (
                        <div className="town-row" key={t.id}>
                          <span>{t.name}</span>
                          <span>
                            <span className="dot" />
                            {
                              partners.filter(
                                (p) =>
                                  p.town_id === t.id && p.status === "active",
                              ).length
                            }{" "}
                            active
                          </span>
                        </div>
                      ))}
                    </section>
                    <div className="notice">
                      <strong>Built for local.</strong>
                      <br />A single workspace for independent takeaways and the
                      communities they serve.
                    </div>
                  </div>
                </div>
              </>
            )}
            {page === "Partners" && (
              <>
                <div className="toolbar">
                  <input
                    aria-label="Search partners"
                    placeholder="Search partners or towns…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <small>{partners.length} partners</small>
                </div>
                <section className="panel">
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Partner</th>
                          <th>Status</th>
                          <th>Pricing</th>
                          <th>Payments</th>
                          <th>Manage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((p) => (
                          <tr key={p.id}>
                            <td>
                              <strong>{p.name}</strong>
                              <small>{p.town}</small>
                            </td>
                            <td>
                              <Status value={p.status} />
                            </td>
                            <td>
                              {p.pricing ? (
                                <>
                                  {money(p.pricing.fixed_fee)} / completed order
                                  <small>
                                    {money(p.pricing.service_fee)} customer fee
                                  </small>
                                </>
                              ) : (
                                <Status value="Pricing required" />
                              )}
                            </td>
                            <td>
                              {p.stripe_account
                                ? "Connected · readiness checked at checkout"
                                : "Cash only"}
                            </td>
                            <td>
                              <div className="row-actions">
                                <button
                                  className="secondary"
                                  onClick={() => {
                                    setSelected(p);
                                    setForm("pricing");
                                  }}
                                >
                                  Pricing
                                </button>
                                {p.status !== "active" ? (
                                  <button
                                    disabled={!p.pricing || busy}
                                    onClick={() =>
                                      void action(
                                        `/admin/partners/${p.id}`,
                                        { status: "active" },
                                        "PATCH",
                                      )
                                    }
                                  >
                                    Activate
                                  </button>
                                ) : (
                                  <button
                                    className="secondary"
                                    onClick={() =>
                                      void action(
                                        `/admin/partners/${p.id}`,
                                        { status: "suspended" },
                                        "PATCH",
                                      )
                                    }
                                  >
                                    Suspend
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            )}
            {page === "Orders" && (
              <section className="panel">{orderTable(filtered)}</section>
            )}
            {page === "Towns and Locations" && (
              <section className="panel">
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Town</th>
                        <th>Partners</th>
                        <th>Availability</th>
                      </tr>
                    </thead>
                    <tbody>
                      {towns.map((t) => (
                        <tr key={t.id}>
                          <td>{t.name}</td>
                          <td>
                            {partners.filter((p) => p.town_id === t.id).length}
                          </td>
                          <td>
                            <Status value="active" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="panel-body">
                  <small>
                    Delivery uses explicitly configured outward postcodes.
                    Radius and polygon zones are not implemented.
                  </small>
                </div>
              </section>
            )}
            {page === "Customers" && (
              <section className="panel">
                {filtered.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Email</th>
                          <th>Joined</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((c) => (
                          <tr key={c.id}>
                            <td>{c.email}</td>
                            <td>
                              {new Date(c.created_at).toLocaleDateString(
                                "en-GB",
                              )}
                            </td>
                            <td>
                              <Status
                                value={c.disabled ? "disabled" : "active"}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    title="No registered customers yet"
                    detail="Guest customers appear on their orders; registered accounts appear here."
                  />
                )}
              </section>
            )}
            {["Finance", "Billing"].includes(page) && data && (
              <>
                <p className="notice">
                  Development ledger and draft invoices. Automatic collection is
                  disabled. Fees shown are before explicitly configured VAT.
                  Subscription billing and invoice issuance are not enabled.
                </p>
                <section className="panel">
                  <div className="panel-head">
                    <h2>
                      {page === "Finance"
                        ? "Financial ledger"
                        : "Weekly invoices"}
                    </h2>
                  </div>
                  {page === "Finance" ? (
                    data.ledger?.length ? (
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Reference</th>
                              <th>Partner</th>
                              <th>Type</th>
                              <th>Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.ledger.map((l: any) => (
                              <tr key={l.id}>
                                <td>
                                  {l.reference}
                                  <small>
                                    {new Date(l.created_at).toLocaleDateString(
                                      "en-GB",
                                    )}
                                  </small>
                                </td>
                                <td>{l.partner}</td>
                                <td>{l.kind.replaceAll("_", " ")}</td>
                                <td>{money(l.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty
                        title="No ledger entries yet"
                        detail="Completed orders generate traceable fees automatically."
                      />
                    )
                  ) : data.invoices?.length ? (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Invoice</th>
                            <th>Partner</th>
                            <th>Total</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.invoices.map((i: any) => (
                            <tr key={i.id}>
                              <td>
                                <button
                                  className="quiet"
                                  onClick={async () => {
                                    setSelected(await api("/invoices/" + i.id));
                                  }}
                                >
                                  {i.number}
                                </button>
                                <small>
                                  {String(i.period_start).slice(0, 10)}
                                </small>
                              </td>
                              <td>{i.partner}</td>
                              <td>{money(i.total)}</td>
                              <td>
                                <Status value={i.status} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty
                      title="No invoices generated"
                      detail="Generate a draft for a closed weekly billing period."
                    />
                  )}
                </section>
                {selected?.lines && (
                  <section className="panel">
                    <div className="panel-body">
                      <h2>{selected.number}</h2>
                      {selected.lines.map((l: any) => (
                        <p key={l.id}>
                          {l.description} · {money(l.net)} + {money(l.vat)} VAT
                        </p>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
            {page === "Helpdesk" && (
              <section className="panel">
                {filtered.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Ticket</th>
                          <th>Priority</th>
                          <th>Status</th>
                          <th>Conversation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((t) => (
                          <tr key={t.id}>
                            <td>{t.subject}</td>
                            <td>{t.priority}</td>
                            <td>
                              <Status value={t.status} />
                            </td>
                            <td>
                              <button
                                className="secondary"
                                onClick={async () => {
                                  setSelected({
                                    ...t,
                                    messages: await api(
                                      `/support/${t.id}/messages`,
                                    ),
                                  });
                                }}
                              >
                                Open
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    title="A clear inbox"
                    detail="Support tickets from your customers and partners will appear here."
                  />
                )}
                {selected?.messages && (
                  <div className="panel-body">
                    <h2>{selected.subject}</h2>
                    {selected.messages.map((m: any) => (
                      <p key={m.id}>{m.body}</p>
                    ))}
                    <form
                      className="support-form"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const body = new FormData(e.currentTarget).get("body");
                        if (
                          await action(`/support/${selected.id}/messages`, {
                            body,
                          })
                        )
                          setSelected({
                            ...selected,
                            messages: await api(
                              `/support/${selected.id}/messages`,
                            ),
                          });
                      }}
                    >
                      <input aria-label="Reply" name="body" required />
                      <button>Send reply</button>
                    </form>
                  </div>
                )}
              </section>
            )}
            {page === "Audit Logs" && (
              <section className="panel">
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Actor</th>
                        <th>Action</th>
                        <th>Subject</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((l) => (
                        <tr key={l.id}>
                          <td>
                            {new Date(l.created_at).toLocaleString("en-GB")}
                          </td>
                          <td>{l.actor || "System"}</td>
                          <td>{l.action}</td>
                          <td>{l.subject}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            {page === "Integrations" && (
              <section className="panel">
                <Empty
                  title="No integrations enabled"
                  detail="External services require credentials and provider verification before activation."
                />
              </section>
            )}
            {page === "Users and Permissions" && (
              <section className="panel">
                <div className="panel-body">
                  <h2>Access with purpose</h2>
                  <p>
                    Partner operators manage day-to-day orders and availability.
                    Business owners also manage products and view finances.
                    Platform administrators approve pricing and partners, and
                    require an authenticator code at sign-in.
                  </p>
                  <p className="notice">
                    Custom roles, administrator provisioning, delegated support
                    access are not implemented. Per-user MFA is managed under
                    Platform Settings. There is no impersonation endpoint.
                  </p>
                </div>
              </section>
            )}
            {page === "Platform Settings" && <MfaManagement />}
            {["Promotions", "Platform Settings"].includes(page) && (
              <section className="panel">
                <Empty
                  title="Planned capability"
                  detail={
                    page === "Promotions"
                      ? "Promotions and loyalty are not implemented or active in this development baseline."
                      : "Global customer fees, tax administration and integration configuration are planned. Partner service fees are configured under Partners → Pricing."
                  }
                />
              </section>
            )}
          </>
        )}
        <footer className="footer-note">
          <span>
            © {new Date().getFullYear()} The North Eats · Made for independent
            food.
          </span>
          <span className="live-dot">
            <span className="dot" />
            Database-backed development workspace
          </span>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
