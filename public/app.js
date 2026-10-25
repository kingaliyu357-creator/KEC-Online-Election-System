document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("#apply form");

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      alert(
        "This is a prototype. Candidate applications are not being submitted yet."
      );
    });
  }
});
