import { Link as RouterLink, useParams } from "react-router-dom";

function resolveWorkspaceHref(href, clientId) {
  if (!href || typeof href !== "string") return href;
  if (!clientId) return href;
  if (href.startsWith("/broker/") || href.startsWith("/client/")) return href;
  if (!href.startsWith("/")) return href;
  return `/broker/client/${clientId}${href}`;
}

export default function Link({ href, to, children, ...props }) {
  const { clientId } = useParams();
  const nextTo = resolveWorkspaceHref(to || href, clientId);

  return (
    <RouterLink to={nextTo} {...props}>
      {children}
    </RouterLink>
  );
}
