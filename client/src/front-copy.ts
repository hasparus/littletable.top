import type { Language } from "../settings";

// The standalone front page's strings: signing in and the account's boards.
// The Polish keeps the board's own words (copy.ts) and stays gender-neutral.
const EN = {
  actionFailed: "That did not work. Try again.",
  boardName: "Board name",
  cancel: "Cancel",
  copyLink: "Copy link",
  delete: "Delete",
  deleteConfirm: "Delete “%(title)s” and everything drawn on it? This cannot be undone.",
  done: "Done",
  linkCopied: "Link copied.",
  linkWasReset: "Its link was reset",
  loading: "Loading…",
  newBoard: "New board",
  newBoardTitle: "Board %(date)s",
  noBoardsYet: "No boards yet. Make one, then send its link to your players.",
  nobodyJoined:
    "Nobody has joined this board with an account yet. People who join with just a name cannot be shamans.",
  people: "People",
  rename: "Rename",
  resetConfirm: "Everyone who has the old link will be put out. Reset the link?",
  resetLink: "Reset link",
  save: "Save",
  shaman: "Shaman",
  shamanHelp:
    "Everyone with the link can draw. A shaman can also connect an AI assistant to this board and choose whether it may read or edit.",
  signedInAs: "Signed in as %(name)s",
  signIn: "Sign in",
  signInFailed: "Signing in did not work. Try again.",
  signInHelp:
    "Sign in to make boards and find them again. Players you send a link to join with just a name.",
  signOut: "Sign out",
  tooManyBoards: "You have as many boards as you can keep. Delete one first.",
  tooManyNewBoards: "You made many boards just now. Wait a while before the next.",
  visited: "Boards you joined",
  yourBoards: "Your boards",
};

export type FrontCopy = Record<keyof typeof EN, string>;

const PL: FrontCopy = {
  actionFailed: "Nie udało się. Spróbuj ponownie.",
  boardName: "Nazwa tablicy",
  cancel: "Anuluj",
  copyLink: "Kopiuj link",
  delete: "Usuń",
  deleteConfirm:
    "Usunąć „%(title)s” razem ze wszystkim, co na niej narysowano? Tego nie da się cofnąć.",
  done: "Gotowe",
  linkCopied: "Skopiowano link.",
  linkWasReset: "Link do niej został zmieniony",
  loading: "Wczytujemy…",
  newBoard: "Nowa tablica",
  newBoardTitle: "Tablica %(date)s",
  noBoardsYet: "Nie ma jeszcze tablic. Załóż jedną i wyślij link osobom, z którymi grasz.",
  nobodyJoined:
    "Nikt jeszcze nie dołączył do tej tablicy z konta. Osoby, które dołączają, podając tylko imię, nie mogą być szamanami.",
  people: "Osoby",
  rename: "Zmień nazwę",
  resetConfirm: "Wszystkie osoby ze starym linkiem stracą dostęp. Zmienić link?",
  resetLink: "Zmień link",
  save: "Zapisz",
  shaman: "Szaman",
  shamanHelp:
    "Każda osoba z linkiem może rysować. Szaman może też podłączyć do tej tablicy asystenta AI i zdecydować, czy ten może tylko czytać, czy też zmieniać.",
  signedInAs: "Zalogowano jako %(name)s",
  signIn: "Zaloguj się",
  signInFailed: "Nie udało się zalogować. Spróbuj ponownie.",
  signInHelp:
    "Zaloguj się, żeby zakładać tablice i łatwo do nich wracać. Osoby, którym wyślesz link, dołączą, podając tylko imię.",
  signOut: "Wyloguj się",
  tooManyBoards: "Masz już najwięcej tablic, ile można. Najpierw usuń którąś.",
  tooManyNewBoards: "Założono właśnie wiele tablic. Zaczekaj chwilę przed kolejną.",
  visited: "Tablice, do których dołączono",
  yourBoards: "Twoje tablice",
};

export const FRONT_COPY: Record<Language, FrontCopy> = { en: EN, pl: PL };
