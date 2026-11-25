const arcana = [
  "The Fool",
  "The Magician",
  "The High Priestess",
  "The Empress",
  "The Emperor",
  "The Hierophant",
  "The Lovers",
  "The Chariot",
  "Strength",
  "The Hermit",
  "Wheel of Fortune",
  "Justice",
  "The Hanged Man",
  "Death",
  "Temperance",
  "The Devil",
  "The Tower",
  "The Star",
  "The Moon",
  "The Sun",
  "Judgement",
  "The World",
];
const officialQuestion = "What does this card ask of your character?";
const panel = document.querySelector("#tarot-lab");
const find = (id) => panel.querySelector("#tarot-" + id);
let remaining;
let activeQuestion = officialQuestion;
let proposal;
let edition = 0;

function shuffle() {
  remaining = [...arcana];
  find("face").textContent = "The deck is shuffled.";
  find("prompt").textContent = "";
  find("count").textContent = remaining.length + " cards left";
  find("draw").disabled = false;
}

function closeReview() {
  proposal = undefined;
  find("review").hidden = true;
}

find("draw").addEventListener("click", () => {
  const index = Math.floor(Math.random() * remaining.length);
  const [card] = remaining.splice(index, 1);
  find("face").textContent = card;
  find("prompt").textContent = activeQuestion;
  find("count").textContent = remaining.length + " cards left";
  find("draw").disabled = remaining.length === 0;
});

find("shuffle").addEventListener("click", shuffle);
find("form").addEventListener("submit", (event) => {
  event.preventDefault();
  const question = find("question").value.trim();
  if (!question || question === officialQuestion) {
    find("status").textContent = "Write a new question for your fork.";
    return;
  }
  proposal = question;
  find("diff").textContent =
    "Replace “" +
    activeQuestion +
    "” with “" +
    proposal +
    "”. Access stays the same. Installing starts a fresh deck.";
  find("fork").open = false;
  find("review").hidden = false;
  find("status").textContent = "Player’s fork submitted. The current deck is still in play.";
  find("install").focus();
});

find("install").addEventListener("click", () => {
  if (!proposal) return;
  activeQuestion = proposal;
  edition += 1;
  find("credit").textContent =
    "Player fork " + edition + " · From Little Table’s Tarot deck, edition 1";
  closeReview();
  shuffle();
  find("status").textContent = "Owner installed the fork. Draw a card to try its question.";
  find("draw").focus();
});

find("dismiss").addEventListener("click", () => {
  closeReview();
  find("status").textContent = "Owner kept the current deck and its draw pile.";
  find("draw").focus();
});

find("question").value = "What will the ferryman take as payment?";
shuffle();
panel.hidden = false;
