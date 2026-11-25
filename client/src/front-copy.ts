import type { Language } from "../settings";

const EN = {
  actionFailed: "That did not work. Try again.",
  boardName: "Board name",
  cancel: "Cancel",
  copyLink: "Copy link",
  created: "Boards created",
  createdOn: "Created %(date)s",
  delete: "Delete",
  deleteConfirm: "Delete “%(title)s” and everything drawn on it? This cannot be undone.",
  done: "Done",
  joinedOn: "Joined %(date)s",
  linkCopied: "Link copied.",
  linkWasReset: "Its link was reset",
  loading: "Loading…",
  manageBoard: "Manage %(title)s",
  manager: "Manager",
  managerHelp:
    "A board manager can connect an assistant and give it permission to read or edit this board.",
  newBoard: "New board",
  newBoardTitle: "Board %(date)s",
  noBoardsYet: "No boards yet. Make one, then send its link to your players.",
  nobodyJoined: "Nobody has joined this board with an account yet.",
  people: "People",
  publicBoard: "Public whiteboard",
  publicBoardLink: "Public board",
  rename: "Rename",
  resetConfirm: "Everyone who has the old link will be put out. Reset the link?",
  resetLink: "Reset link",
  save: "Save",
  signedInAs: "Signed in as %(name)s",
  signIn: "Sign in",
  signInFailed: "Signing in did not work. Try again.",
  signInHelp:
    "Sign in to make boards and find them again. Players you send a link to join with just a name.",
  signOut: "Sign out",
  tooManyBoards: "You have as many boards as you can keep. Delete one first.",
  tooManyNewBoards: "You made many boards just now. Wait a while before the next.",
  visited: "Boards joined",
  yourBoards: "Your boards",
};

export type FrontCopy = typeof EN;

const PL: FrontCopy = {
  actionFailed: "Nie udało się. Spróbuj ponownie.",
  boardName: "Nazwa tablicy",
  cancel: "Anuluj",
  copyLink: "Kopiuj link",
  created: "Utworzone tablice",
  createdOn: "Utworzono %(date)s",
  delete: "Usuń",
  deleteConfirm:
    "Usunąć „%(title)s” razem ze wszystkim, co na niej narysowano? Tego nie da się cofnąć.",
  done: "Gotowe",
  joinedOn: "Dołączono %(date)s",
  linkCopied: "Skopiowano link.",
  linkWasReset: "Link do niej zmieniono",
  loading: "Wczytujemy…",
  manageBoard: "Zarządzaj tablicą „%(title)s”",
  manager: "Opiekun tablicy",
  managerHelp:
    "Opiekun tablicy może podłączyć asystenta i zezwolić mu na odczyt lub edycję tej tablicy.",
  newBoard: "Nowa tablica",
  newBoardTitle: "Tablica %(date)s",
  noBoardsYet: "Nie ma jeszcze tablic. Załóż jedną i wyślij link osobom, z którymi grasz.",
  nobodyJoined: "Nikt jeszcze nie dołączył do tej tablicy, korzystając z konta.",
  people: "Osoby",
  publicBoard: "Tablica publiczna",
  publicBoardLink: "Tablica publiczna",
  rename: "Zmień nazwę",
  resetConfirm: "Wszystkie osoby ze starym linkiem stracą dostęp. Zmienić link?",
  resetLink: "Zmień link",
  save: "Zapisz",
  signedInAs: "Zalogowano jako %(name)s",
  signIn: "Zaloguj się",
  signInFailed: "Nie udało się zalogować. Spróbuj ponownie.",
  signInHelp:
    "Zaloguj się, żeby zakładać tablice i do nich wracać. Osoby, którym wyślesz link, wpiszą tylko imię.",
  signOut: "Wyloguj się",
  tooManyBoards: "Masz już maksymalną liczbę tablic. Najpierw usuń którąś.",
  tooManyNewBoards: "Założono właśnie wiele tablic. Zaczekaj chwilę przed kolejną.",
  visited: "Tablice, do których dołączono",
  yourBoards: "Twoje tablice",
};

export const FRONT_COPY: Record<Language, FrontCopy> = { en: EN, pl: PL };

export const LANDING_COPY = {
  publicBoard: EN.publicBoard,
  publicExpiry: "Anyone can draw here. Drawings fade after a day\nand disappear after two.",
  publicStory: [
    "I complained whenever my friends invited me to use\nRoll20 or another virtual tabletop. It was awkward\non phones, it had too many features, and filling out\nforms felt like paperwork.",
    "Why bother, when we could use a whiteboard app,\nupload screenshots of PDFs, and draw on them just\nlike on a real table?",
    "We started playing with Miro, Excalidraw and tldraw.\nIt was way better, but a few small features were\nmissing. My ideal app didn't exist... yet.",
    "Little Table is this app. Just a whiteboard with dice\nrolls, search over text in images and secret layers.\nA virtual tabletop without bloat.",
  ],
  signIn: EN.signIn,
};

export type LandingCopy = typeof LANDING_COPY;
