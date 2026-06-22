// js/auth-page.js – entry point for standalone authentication page
import { initApp } from "./common.js";

// Initialize Firebase listeners and UI
initApp();

// Tab switching in Auth section (exposed globally for inline handlers)
window.toggleAuthTab = function(type) {
  const tabLogin = document.getElementById("tab-login");
  const tabSignup = document.getElementById("tab-signup");
  const formLogin = document.getElementById("login-form");
  const formSignup = document.getElementById("signup-form");

  if (!tabLogin || !tabSignup || !formLogin || !formSignup) return;

  if (type === "login") {
    tabLogin.classList.add("active");
    tabSignup.classList.remove("active");
    formLogin.classList.remove("hidden");
    formSignup.classList.add("hidden");
  } else {
    tabSignup.classList.add("active");
    tabLogin.classList.remove("active");
    formSignup.classList.remove("hidden");
    formLogin.classList.add("hidden");
  }
};
