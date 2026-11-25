import { fill } from "./copy";
import { useGizmoUi } from "./gizmo-ui";

export function DeckAnnouncement({ name }: { name: string }) {
  const { copy } = useGizmoUi();
  return (
    <div aria-live="polite" className="sr-only">
      {name && fill(copy.deckRevealed, { card: name })}
    </div>
  );
}
