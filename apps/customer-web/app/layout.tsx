import React from "react";
import "../../../packages/ui/src/styles.css";
export const metadata = {
  title: "The North Eats · Independent food, delivered locally",
  description:
    "Discover independent takeaways across Lancaster, Morecambe and beyond.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
