import React from "react";

export function BrowserRouter({ children }) {
  return React.createElement(React.Fragment, null, children);
}

export function Link({ children, to = "#", ...props }) {
  return React.createElement("a", { href: String(to || "#"), ...props }, children);
}

export const NavLink = Link;

export function Navigate() {
  return null;
}

export function Outlet() {
  return null;
}

export function useLocation() {
  return { pathname: "/", search: "", hash: "", state: null };
}

export function useNavigate() {
  return () => {};
}

export function useParams() {
  return {};
}

export function useSearchParams() {
  return [new URLSearchParams(), () => {}];
}
