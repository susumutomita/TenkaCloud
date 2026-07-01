/**
 * Golden reference portal extension component.
 *
 * Demonstrates the participant-portal extension contract: a problem ships a
 * `portal/*.tsx` component, wires it through `dashboard.slots` in metadata.json,
 * and the portal renders it with {@link PortalSlotProps}. This component is pure
 * presentation over the props the portal injects — no network, no secrets.
 *
 * See the Developer Portal reference docs for the full slot contract.
 */
import type { PortalSlotProps } from "@tenkacloud/portal-plugin-sdk";

export default function UptimeCard(props: PortalSlotProps): JSX.Element {
  const service = props.endpoints.find((endpoint) => endpoint.slot === "service");
  const url = service?.effectiveUrl ?? service?.defaultUrl ?? "(not deployed)";
  return (
    <section aria-label="Uptime status">
      <h3>Service uptime</h3>
      <p>Score: {props.score}</p>
      <p>Probed endpoint: {url}</p>
    </section>
  );
}
