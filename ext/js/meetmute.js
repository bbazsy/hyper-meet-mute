const MUTE_BUTTON = '[role="button"][aria-label*="mic"][data-is-muted]';

// Variables to track state
let muted = false;
let port = null;
let isMutedObserver = null;
let waitingForMuteButton = false;

// Establish a long-lived connection with the background script
function connectToBackgroundScript() {
  try {
    port = chrome.runtime.connect({ name: "meetmute-connection" });
    console.log("Connected to background script");
    
    // Set up message listener on the port
    port.onMessage.addListener((message) => {
      console.log("Received message from background:", message);
      handleMessage(message);
    });
    
    // Handle disconnection (will try to reconnect if extension is still active)
    port.onDisconnect.addListener(() => {
      console.log("Disconnected from background script");
      port = null;
      
      // Try to reconnect if this was due to a service worker restart
      if (chrome.runtime.lastError) {
        console.log("Attempting to reconnect...");
        setTimeout(connectToBackgroundScript, 1000);
      }
    });
    
    // Notify that we're loaded
    chrome.runtime.sendMessage({ message: "content_script_loaded" })
      .catch(error => {
        console.log("Error sending initial message:", error);
      });
      
  } catch (error) {
    console.error("Error connecting to background script:", error);
  }
}

// Connect when the script loads
connectToBackgroundScript();

const waitUntilElementExists = (DOMSelector, MAX_TIME = 5000) => {
  let timeout = 0;

  const waitForContainerElement = (resolve, reject) => {
    const container = document.querySelector(DOMSelector);
    timeout += 100;

    if (timeout >= MAX_TIME) reject("Element not found");

    if (!container || container.length === 0) {
      setTimeout(waitForContainerElement.bind(this, resolve, reject), 100);
    } else {
      resolve(container);
    }
  };

  return new Promise((resolve, reject) => {
    waitForContainerElement(resolve, reject);
  });
};

function waitForMuteButton() {
  if (waitingForMuteButton) {
    return;
  }
  waitingForMuteButton = true;
  waitUntilElementExists(MUTE_BUTTON)
    .then((el) => {
      waitingForMuteButton = false;
      updateMuted();
      watchIsMuted(el);
      
      // Notify background script that we found the mute button
      sendMessageToBackground({ message: "mute_button_found" });
    })
    .catch((error) => {
      sendMessageToBackground({ message: "disconnected" });
      waitingForMuteButton = false;
    });
}

function isMuted() {
  let dataIsMuted = document
    .querySelector(MUTE_BUTTON)
    .getAttribute("data-is-muted");
  return dataIsMuted == "true";
}

function updateMuted(newValue) {
  try {
    const muteButton = document.querySelector(MUTE_BUTTON);
    if (muteButton) {
      muted = newValue !== undefined ? newValue : isMuted();
      
      // Send the final state back to the background script
      // This will update the badge with the correct color
      sendMessageToBackground({ 
        message: muted ? "muted" : "unmuted",
        finalState: true  // Flag to indicate this is the final state
      });
    }
  } catch (error) {
    console.error("Error updating mute state:", error);
  }
}

// Helper function to send messages to the background script
function sendMessageToBackground(message) {
  // First try to use the port if available
  if (port) {
    try {
      port.postMessage(message);
      return;
    } catch (error) {
      console.error("Error posting message via port:", error);
      // If port fails, fall back to one-time message
    }
  }
  
  // Fall back to one-time message
  chrome.runtime.sendMessage(message).catch(error => {
    console.error("Error sending message to background:", error);
  });
}

function watchIsMuted(el) {
  if (isMutedObserver) {
    isMutedObserver.disconnect();
  }
  isMutedObserver = new MutationObserver((mutations) => {
    let newValue = mutations[0].target.getAttribute("data-is-muted") == "true";

    if (newValue != muted) {
      updateMuted(newValue);
    }
  });
  isMutedObserver.observe(el, {
    attributes: true,
    attributeFilter: ["data-is-muted"],
  });
}

function watchBodyClass() {
  const bodyClassObserver = new MutationObserver((mutations) => {
    let newClass = mutations[0].target.getAttribute("class");
    if (mutations[0].oldValue != newClass) {
      waitForMuteButton();
    }
  });
  bodyClassObserver.observe(document.querySelector("body"), {
    attributes: true,
    attributeFilter: ["class"],
    attributeOldValue: true,
  });
}

watchBodyClass();

window.onbeforeunload = (event) => {
  chrome.runtime.sendMessage({ message: "disconnected" });
};

// Handle messages from both port and one-time messages
function handleMessage(request) {
  try {
    console.log("Content script received message:", request);
    
    // Check if the mute button exists before trying to check mute state
    const muteButton = document.querySelector(MUTE_BUTTON);
    if (muteButton) {
      // Get current state
      muted = isMuted();
      console.log("Current mute state before action:", muted);
      
      // Handle different actions
      if (request && request.action === "toggleMute") {
        console.log("Toggling mute from", muted, "to", !muted);
        muted = !muted;
        
        // Send the keyboard command to toggle mute
        sendKeyboardCommand();
        
        // Use a more reliable approach with multiple checks
        // First check quickly to catch fast UI updates
        setTimeout(() => {
          const quickCheckState = isMuted();
          console.log("Quick check mute state:", quickCheckState);
          
          // Then do a final check after a longer delay to ensure stability
          setTimeout(() => {
            const finalState = isMuted();
            console.log("Final mute state after toggle:", finalState);
            
            // Only update if the state is different from our quick check
            // This prevents unnecessary flickering
            if (finalState !== quickCheckState) {
              console.log("State changed between checks, updating to final state");
            }
            
            // Always update with the final verified state
            updateMuted(finalState);
          }, 200);
        }, 50);
      }
      
      // Always send a response with the current state
      return { message: muted ? "muted" : "unmuted", success: true };
    } else {
      console.log("Mute button not found yet, waiting...");
      waitForMuteButton();
      return { message: "mute_button_not_found" };
    }
  } catch (error) {
    console.error("Error handling message:", error);
    return { error: error.message };
  }
}

// Listen for one-time messages from the background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const response = handleMessage(request);
  sendResponse(response);
  return true; // Keep the message channel open for async response
});

const keydownEvent = new KeyboardEvent("keydown", {
  key: "d",
  code: "KeyD",
  metaKey: true,
  charCode: 100,
  keyCode: 100,
  which: 100,
});

function sendKeyboardCommand() {
  document.dispatchEvent(keydownEvent);
}
