
document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("#application-form");
  const message = document.querySelector("#form-message");

  if (!form || !message) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = form.querySelector(
      'button[type="submit"]'
    );

    const photoInput = form.querySelector('[name="photo"]');
    const photoFile = photoInput.files[0];

    if (!photoFile) {
      message.textContent = "Please select your photograph.";
      return;
    }

    if (!photoFile.type.startsWith("image/")) {
      message.textContent = "Please select a valid image.";
      return;
    }

    if (photoFile.size > 2 * 1024 * 1024) {
      message.textContent = "Image must be smaller than 2 MB.";
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Submitting...";
    message.textContent = "Please wait while your application is submitted.";

    try {
      const photo = await new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(
          new Error("Unable to read the selected photograph.")
        );

        reader.readAsDataURL(photoFile);
      });

      const formData = new FormData(form);

      const payload = {
        fullName: formData.get("fullName"),
        email: formData.get("email"),
        phone: formData.get("phone"),
        position: formData.get("position"),
        photo,
        contribution: formData.get("contribution"),
        pledge: formData.get("pledge") === "on"
      };

      const response = await fetch("/api/applications", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.message || "Application submission failed."
        );
      }

      message.textContent =
        "Application submitted successfully! Your application is pending admin review. Your Candidate ID will be created only if your application is approved.";

      form.reset();
    } catch (error) {
      message.textContent =
        error.message ||
        "Something went wrong. Please try again.";
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Submit Application";
    }
  });
});
