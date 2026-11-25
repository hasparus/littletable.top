import { useEffect, useState } from "react";
import { type Editor, type TLPageId, type TLShapeId, useValue } from "tldraw";

import type { Hit, SearchKind } from "./search-index";

import { type Copy, fill } from "./copy";
import { flash } from "./highlight";
import { Icon, type IconName } from "./icons";
import { boundsOf } from "./image-quad";
import { usePageNames } from "./pages";
import {
  goTo,
  goToBounds,
  MAX_PLACE_NAME,
  nameAsPlace,
  ordered,
  type Place,
  placeName,
  placesOn,
  removePlace,
  suggestedName,
  useMyPlace,
} from "./places";
import { oneLine } from "./search-text";
import { Sheet } from "./sheet";
import { useBoardUi } from "./ui";

const ROW_BUTTON =
  "grid size-11 shrink-0 place-items-center rounded-full text-foreground-muted hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-border-focus";

const SEARCH_ICON = "pointer-events-none absolute start-3 top-1/2 size-5 -translate-y-1/2";
const SEARCH_TEXT_PADDING = "ps-10 pe-3";

export const SEARCH_FIELD_ID = "board-search-field";
const RESULTS_ID = "board-search-results";
const optionId = (index: number) => `board-search-hit-${index}`;

const SOURCES: Record<SearchKind, { icon: IconName; label: keyof Copy | null; seen: boolean }> = {
  native: { icon: "Text", label: null, seen: false },
  ocr: { icon: "Photo", label: "searchInImage", seen: true },
  place: { icon: "PinIcon", label: "searchPlace", seen: false },
};

function NameForm({ editor, shape }: { editor: Editor; shape: TLShapeId }) {
  const { copy, setNaming } = useBoardUi();
  const [name, setName] = useState(() => {
    const target = editor.getShape(shape);
    return target === undefined ? "" : (placeName(target) ?? suggestedName(target));
  });
  return (
    <form
      className="rounded-xl bg-bg-tertiary p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim().length === 0) return;
        nameAsPlace(editor, shape, name);
        setNaming(null);
      }}
    >
      <label className="block text-sm font-medium" htmlFor="board-place-name">
        {copy.placeName}
      </label>
      <input
        autoComplete="off"
        className="mt-1 block h-11 w-full rounded-lg border border-border bg-bg-secondary px-3 text-base focus:border-primary focus:outline-none"
        data-autofocus
        enterKeyHint="done"
        id="board-place-name"
        maxLength={MAX_PLACE_NAME}
        onChange={(event) => setName(event.target.value)}
        required
        value={name}
      />
      <div className="mt-3 flex justify-end gap-2">
        <button
          className="btn btn-secondary min-h-11"
          onClick={() => setNaming(null)}
          type="button"
        >
          {copy.cancel}
        </button>
        <button className="btn btn-primary min-h-11" type="submit">
          {copy.save}
        </button>
      </div>
    </form>
  );
}

function PlacesList({
  list,
  mine,
  pages,
  setMine,
}: {
  list: Place[];
  mine: TLShapeId | null;
  pages: Map<TLPageId, string> | null;
  setMine: (id: TLShapeId | null) => void;
}) {
  const { copy, editor, open } = useBoardUi();
  return (
    <>
      <h3 className="my-1 px-3 text-sm font-medium text-foreground-secondary">{copy.places}</h3>
      <ul className="space-y-0.5">
        {list.map((place) => {
          const starred = place.id === mine;
          return (
            <li className="flex items-center rounded-lg hover:bg-bg-tertiary" key={place.id}>
              <button
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-focus"
                onClick={() => {
                  if (editor === null) return;
                  open(null);
                  goTo(editor, place.id);
                }}
                type="button"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-base">{place.name}</span>
                  {pages !== null && (
                    <span className="truncate text-sm text-foreground-muted">
                      {pages.get(place.page)}
                    </span>
                  )}
                </span>
                {starred && (
                  <span className="shrink-0 rounded-full bg-primary-light px-2 py-0.5 text-xs font-medium text-primary-strong">
                    {copy.myPlace}
                  </span>
                )}
              </button>
              <button
                aria-label={`${copy.myPlace}: ${place.name}`}
                aria-pressed={starred}
                className={`${ROW_BUTTON} ${starred ? "text-warning" : ""}`}
                onClick={() => setMine(starred ? null : place.id)}
                type="button"
              >
                <Icon name={starred ? "Star" : "StarOutline"} />
              </button>
              <button
                aria-label={`${copy.removePlace}: ${place.name}`}
                className={ROW_BUTTON}
                onClick={() => editor !== null && removePlace(editor, place.id)}
                type="button"
              >
                <Icon name="Trash" />
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Results({
  active,
  choose,
  hits,
  pages,
  setActive,
}: {
  active: number;
  choose: (hit: Hit) => void;
  hits: Hit[];
  pages: Map<TLPageId, string> | null;
  setActive: (index: number) => void;
}) {
  const { copy } = useBoardUi();
  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <ul aria-label={copy.searchResults} className="space-y-1" id={RESULTS_ID} role="listbox">
      {hits.map((hit, index) => {
        const source = SOURCES[hit.doc.kind];
        const label = source.label === null ? null : copy[source.label];
        const page = pages?.get(hit.doc.page);
        return (
          // WARNING: Keep focus in the combobox input so aria-activedescendant can announce the active option.
          <li
            aria-selected={index === active}
            className={`relative flex min-h-12 cursor-pointer items-center rounded-xl py-2 aria-selected:bg-bg-tertiary ${SEARCH_TEXT_PADDING}`}
            id={optionId(index)}
            key={hit.doc.id}
            onClick={() => choose(hit)}
            onPointerMove={() => index === active || setActive(index)}
            role="option"
          >
            <Icon className={`${SEARCH_ICON} text-primary`} name={source.icon} />
            <span className="flex min-w-0 flex-col">
              <span className="line-clamp-2 text-base wrap-break-word">
                {label !== null && !source.seen && <span className="sr-only">{`${label}: `}</span>}
                {hit.excerpt.map((part, at) =>
                  part.mark ? (
                    <mark className="rounded-sm bg-primary-light text-primary-strong" key={at}>
                      {part.text}
                    </mark>
                  ) : (
                    <span key={at}>{part.text}</span>
                  ),
                )}
              </span>
              {(page !== undefined || source.seen) && (
                <span className="flex min-w-0 items-center gap-2 text-sm text-foreground-muted">
                  {source.seen && label !== null && (
                    <span className="shrink-0 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs ring-1 ring-border">
                      {label}
                    </span>
                  )}
                  {page !== undefined && <span className="truncate">{page}</span>}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const finePointer = () => globalThis.matchMedia("(pointer: fine)").matches;

export function SearchSheet() {
  const {
    board,
    copy,
    editor,
    highlight,
    imageText,
    locale,
    naming,
    open,
    search,
    setNaming,
    typing,
  } = useBoardUi();
  const reading = useValue("images being read", () => imageText?.pending.get() ?? 0, [imageText]);
  const [mine, setMine] = useMyPlace(board);
  const places = useValue("board places", () => (editor === null ? [] : placesOn(editor)), [
    editor,
  ]);
  const candidate = useValue(
    "place candidate",
    () => {
      const shapes = editor?.getSelectedShapes() ?? [];
      return shapes.length === 1 && placeName(shapes[0]!) === null ? shapes[0]!.id : null;
    },
    [editor],
  );
  const pages = usePageNames(editor);
  const list = ordered(places, mine, locale);

  // WARNING: Autofocusing on a touch screen opens the keyboard over the places list.
  const focusField = typing || finePointer();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => search?.watch(), [search]);
  const typed = oneLine(query);
  const hits = useValue(
    "search hits",
    () => {
      if (typed.length === 0 || search === null) return null;
      search.version.get();
      return search.search(typed);
    },
    [search, typed],
  );
  const current = hits === null ? -1 : Math.min(active, hits.length - 1);

  const choose = (hit: Hit) => {
    if (editor === null || search === null) return;
    const found = search.regionOf(hit);
    if (found === null) return;
    const { hidden, polygon } = found;
    const page = editor.getAncestorPageId(hit.doc.shape) ?? hit.doc.page;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    open(null);
    goToBounds(editor, page, boundsOf(polygon));
    flash(highlight, {
      label: hit.excerpt.map((part) => part.text).join(""),
      note: hidden ? copy.searchHiddenByCrop : null,
      page,
      polygon,
    });
  };

  const field = (
    <div className="relative min-w-0 flex-1">
      <Icon className={`${SEARCH_ICON} text-foreground-muted`} name="MagnifyingGlass" />
      <input
        aria-activedescendant={current >= 0 ? optionId(current) : undefined}
        aria-autocomplete="list"
        aria-controls={hits !== null && hits.length > 0 ? RESULTS_ID : undefined}
        aria-expanded={hits !== null && hits.length > 0}
        aria-label={copy.searchBoard}
        autoComplete="off"
        className={`block h-11 w-full rounded-xl bg-bg-tertiary text-base inset-ring inset-ring-border focus:inset-ring-primary focus:outline-none [&::-webkit-search-cancel-button]:hidden ${SEARCH_TEXT_PADDING}`}
        data-autofocus={focusField && naming === null ? "" : undefined}
        enterKeyHint="search"
        id={SEARCH_FIELD_ID}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query !== "") {
            event.preventDefault();
            setQuery("");
            setActive(0);
            return;
          }
          if (hits === null || hits.length === 0) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((current + step + hits.length) % hits.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            choose(hits[current]!);
          }
        }}
        placeholder={copy.searchBoard}
        role="combobox"
        spellCheck={false}
        type="search"
        value={query}
      />
    </div>
  );

  const placesPart =
    list.length > 0 ? (
      <PlacesList list={list} mine={mine} pages={pages} setMine={setMine} />
    ) : (
      hits === null && <p className="px-3 py-1 text-sm text-foreground-muted">{copy.noPlacesYet}</p>
    );

  return (
    <Sheet field={field} panel="search" title={copy.search}>
      {reading > 0 && naming === null && (
        <p className="pb-1 text-sm text-foreground-muted" role="status">
          {reading === 1
            ? copy.searchReadingImage
            : fill(copy.searchReadingImages, { count: reading })}
        </p>
      )}
      {editor !== null && naming !== null ? (
        <NameForm editor={editor} shape={naming} />
      ) : hits === null ? (
        <>
          {candidate !== null && (
            <button
              className="btn btn-secondary mt-1 mb-2 min-h-11 w-full gap-2"
              onClick={() => setNaming(candidate)}
              type="button"
            >
              <Icon className="size-4" name="Plus" />
              {copy.addToPlaces}
            </button>
          )}
          {placesPart}
        </>
      ) : hits.length === 0 ? (
        <>
          <div className="py-3" role="status">
            <p className="text-base">{fill(copy.searchNothing, { query: typed })}</p>
            <p className="mt-1 text-sm text-foreground-muted">{copy.searchNothingHelp}</p>
          </div>
          {placesPart}
        </>
      ) : (
        <Results active={current} choose={choose} hits={hits} pages={pages} setActive={setActive} />
      )}
    </Sheet>
  );
}
