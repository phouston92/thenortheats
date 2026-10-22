import React, { useEffect, useState } from "react";
import {
  SafeAreaView,
  ScrollView,
  Text,
  View,
  TextInput,
  Pressable,
  StyleSheet,
  Platform,
} from "react-native";
import { money } from "../../packages/shared/src/index";
const base = process.env.EXPO_PUBLIC_API_URL || "http://localhost:3001";
export default function App() {
  const [screen, setScreen] = useState("discover");
  const [towns, setTowns] = useState<any[]>([]);
  const [town, setTown] = useState("Lancaster");
  const [partners, setPartners] = useState<any[]>([]);
  const [menu, setMenu] = useState<any>(null);
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<any>(null);
  const [user, setUser] = useState<any>(null);
  const [csrf, setCsrf] = useState("");
  const [error, setError] = useState("");
  const [trackingId, setTrackingId] = useState("");
  const [order, setOrder] = useState<any>(null);
  async function request(path: string, body?: any) {
    const res = await fetch(base + "/api" + path, {
      method: body ? "POST" : "GET",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
  }
  async function run(fn: () => Promise<void>) {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void run(async () => setTowns(await request("/towns")));
  }, []);
  useEffect(() => {
    void run(async () =>
      setPartners(await request("/partners?town=" + encodeURIComponent(town))),
    );
  }, [town]);
  useEffect(() => {
    if (screen !== "tracking" || !trackingId) return;
    const poll = () =>
      run(async () => setOrder(await request("/orders/" + trackingId)));
    void poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, [screen, trackingId]);
  const button = (label: string, fn: () => void) => (
    <Pressable accessibilityRole="button" style={styles.button} onPress={fn}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.brand}>THE NORTH EATS</Text>
        <Text style={styles.sub}>Independent food. Local favourites.</Text>
        <View style={styles.nav}>
          {["discover", "basket", "tracking", "account"].map((s) => (
            <Pressable
              key={s}
              accessibilityRole="button"
              onPress={() => setScreen(s)}
            >
              <Text style={styles.link}>{s}</Text>
            </Pressable>
          ))}
        </View>
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        {screen === "discover" && (
          <>
            <Text style={styles.title}>Your town. Your next favourite.</Text>
            <View style={styles.nav}>
              {towns.map((t) => (
                <Pressable
                  accessibilityRole="button"
                  key={t.id}
                  onPress={() => setTown(t.name)}
                >
                  <Text style={styles.link}>
                    {t.name === town ? "● " : ""}
                    {t.name}
                  </Text>
                </Pressable>
              ))}
            </View>
            {partners.length ? (
              partners.map((p) => (
                <View key={p.id} style={styles.card}>
                  <Text style={styles.heading}>{p.name}</Text>
                  <Text>
                    {p.town} · {p.preparation_minutes} min
                  </Text>
                  {button(
                    "Explore menu",
                    () =>
                      void run(async () => {
                        setMenu(await request("/partners/" + p.id + "/menu"));
                        setBasket({});
                        setScreen("menu");
                      }),
                  )}
                </View>
              ))
            ) : (
              <Text>No takeaways are currently accepting orders here.</Text>
            )}
          </>
        )}
        {screen === "menu" && menu && (
          <>
            <Text style={styles.title}>{menu.partner.name}</Text>
            {menu.products.map((p: any) => (
              <View key={p.id} style={styles.card}>
                <Text style={styles.heading}>{p.name}</Text>
                <Text>
                  {money(p.price)} · {p.allergens.join(", ")}
                </Text>
                {p.available &&
                  button("Add to basket", () =>
                    setBasket((b) => ({ ...b, [p.id]: (b[p.id] || 0) + 1 })),
                  )}
              </View>
            ))}
          </>
        )}
        {screen === "basket" && (
          <>
            <Text style={styles.title}>Your basket</Text>
            {menu?.products
              .filter((p: any) => basket[p.id])
              .map((p: any) => (
                <View key={p.id} style={styles.card}>
                  <Text>
                    {basket[p.id]} × {p.name} · {money(p.price * basket[p.id])}
                  </Text>
                  {button("Remove one", () =>
                    setBasket((b) => ({
                      ...b,
                      [p.id]: Math.max(0, b[p.id] - 1),
                    })),
                  )}
                </View>
              ))}
            {menu && (
              <Text>Customer service fee: {money(menu.serviceFee)}</Text>
            )}
            <Text style={styles.note}>
              Mobile checkout is a foundation only. Place orders through the
              customer website. Native payments and push notifications are not
              configured or verified.
            </Text>
          </>
        )}
        {screen === "tracking" && (
          <>
            <Text style={styles.title}>Follow your food</Text>
            <TextInput
              accessibilityLabel="Order ID"
              placeholder="Order ID from your account"
              style={styles.input}
              value={trackingId}
              onChangeText={setTrackingId}
            />
            {order && (
              <View style={styles.card}>
                <Text style={styles.heading}>
                  {order.status.replaceAll("_", " ")}
                </Text>
                <Text>
                  {money(order.total)} · {order.payment_state}
                </Text>
                {order.items.map((i: any) => (
                  <Text key={i.name}>
                    {i.quantity} × {i.name}
                  </Text>
                ))}
              </View>
            )}
            <Text style={styles.note}>
              Sign in to track your registered account orders. Guest tracking
              capabilities are currently stored by the website only.
            </Text>
          </>
        )}
        {screen === "account" && (
          <>
            <Text style={styles.title}>
              {user ? "Your account" : "Welcome back"}
            </Text>
            {user ? (
              <>
                <Text>{user.email}</Text>
                {button(
                  "Load my latest order",
                  () =>
                    void run(async () => {
                      const orders = await request("/account/orders");
                      if (orders[0]) {
                        setTrackingId(orders[0].id);
                        setScreen("tracking");
                      } else setError("No orders yet.");
                    }),
                )}
                {button(
                  "Sign out",
                  () =>
                    void run(async () => {
                      await request("/auth/logout", {});
                      setUser(null);
                      setCsrf("");
                    }),
                )}
              </>
            ) : (
              <>
                <TextInput
                  style={styles.input}
                  accessibilityLabel="Email"
                  placeholder="Email address"
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  keyboardType="email-address"
                />
                {challenge && (
                  <TextInput
                    style={styles.input}
                    accessibilityLabel="Verification code"
                    placeholder="Six-digit code"
                    value={code}
                    onChangeText={setCode}
                    keyboardType="number-pad"
                  />
                )}
                {button(
                  challenge ? "Verify code" : "Email me a code",
                  () =>
                    void run(async () => {
                      if (!challenge)
                        setChallenge(await request("/auth/request", { email }));
                      else {
                        const r = await request("/auth/verify", {
                          ...challenge,
                          code,
                        });
                        setUser(r.user);
                        setCsrf(r.csrf);
                      }
                    }),
                )}
              </>
            )}
          </>
        )}
        <Text style={styles.note}>
          Development foundation · {Platform.OS}. API endpoint must be reachable
          from your device. Notifications require a future configured provider
          and permissions.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f6f7f9" },
  content: {
    padding: 24,
    paddingTop: 48,
    maxWidth: 700,
    width: "100%",
    alignSelf: "center",
  },
  brand: { fontWeight: "800", fontSize: 23, color: "#1b1e23" },
  sub: { color: "#646a75", marginVertical: 8 },
  nav: { flexDirection: "row", gap: 18, flexWrap: "wrap", marginVertical: 18 },
  link: { color: "#a23b00", fontWeight: "600", textTransform: "capitalize" },
  title: {
    fontSize: 32,
    fontWeight: "800",
    marginVertical: 20,
    color: "#1b1e23",
  },
  heading: { fontSize: 20, fontWeight: "700", marginBottom: 10 },
  card: {
    padding: 20,
    borderRadius: 14,
    backgroundColor: "#fff",
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  button: {
    backgroundColor: "#ff5e00",
    padding: 14,
    borderRadius: 9,
    marginTop: 14,
  },
  buttonText: { fontWeight: "700", color: "#191c21" },
  input: {
    padding: 14,
    borderWidth: 1,
    borderColor: "#c9cdd3",
    borderRadius: 8,
    backgroundColor: "#fff",
    marginVertical: 9,
  },
  error: { color: "#971d1d", backgroundColor: "#fff0f0", padding: 12 },
  note: { fontSize: 12, color: "#626875", lineHeight: 20, marginVertical: 20 },
});
