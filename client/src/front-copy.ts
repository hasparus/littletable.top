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
  linkCopied: "Link copied.",
  linkWasReset: "Its link was reset",
  loading: "Loading…",
  newBoard: "New board",
  newBoardTitle: "Board %(date)s",
  noBoardsYet: "No boards yet. Make one, then send its link to your players.",
  publicBoard: "Public whiteboard",
  publicExpiry: "Anyone can draw here. Drawings fade after a day and disappear after two.",
  publicGreeting: "Hey there",
  publicStory: [
    "Whenever my friends invited me to play on Roll20 or another virtual tabletop, I complained. It was awkward on a phone, it had too many features, and even a character sheet meant filling out forms.",
    "Why do all that when we could drop screenshots from our PDFs onto a whiteboard and draw on them, just like at a real table?",
    "We tried Miro, Excalidraw, and tldraw. It was way better, but I still missed a few things. My ideal app didn’t exist yet.",
    "So I made Little Table. Just a whiteboard with dice and search that reads text in images. Secret layers are still on my list. A virtual tabletop without the bloat.",
  ],
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
  visited: "Boards you joined",
  yourBoards: "Your boards",
};

export type FrontCopy = typeof EN;

const PL: FrontCopy = {
  actionFailed: "Nie udało się. Spróbuj ponownie.",
  boardName: "Nazwa tablicy",
  cancel: "Anuluj",
  copyLink: "Kopiuj link",
  delete: "Usuń",
  deleteConfirm:
    "Usunąć „%(title)s” razem ze wszystkim, co na niej narysowano? Tego nie da się cofnąć.",
  linkCopied: "Skopiowano link.",
  linkWasReset: "Link do niej zmieniono",
  loading: "Wczytujemy…",
  newBoard: "Nowa tablica",
  newBoardTitle: "Tablica %(date)s",
  noBoardsYet: "Nie ma jeszcze tablic. Załóż jedną i wyślij link osobom, z którymi grasz.",
  publicBoard: "Tablica publiczna",
  publicExpiry: "Każdy może tu rysować. Rysunki bledną po dniu i znikają po dwóch.",
  publicGreeting: "Cześć",
  publicStory: [
    "Gdy znajomi zapraszali mnie do gry na Roll20 albo innym wirtualnym stole, zawsze było na co ponarzekać. Na telefonie było niewygodnie, funkcji było za dużo, a nawet karta postaci wymagała wypełniania formularzy.",
    "Po co to wszystko, skoro można wrzucić zrzuty z PDF-ów na tablicę i po nich rysować, tak jak przy prawdziwym stole?",
    "Spróbowaliśmy Miro, Excalidraw i tldraw. Było dużo lepiej, ale nadal brakowało mi kilku drobiazgów. Aplikacji, której szukałem, jeszcze nie było.",
    "Tak powstało Little Table. To tablica, na której można rzucać kośćmi i wyszukiwać tekst na obrazach. Chcę jeszcze dodać ukryte warstwy. Wirtualny stół bez zbędnych dodatków.",
  ],
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
