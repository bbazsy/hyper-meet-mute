// js/background.js (Service Worker for Manifest V3)

// Keep track of active Meet tabs and global state
let activeMeetTabs = new Map();
let globalMuteState = {
  isMuted: false,
  hasMeetTab: false
};

// Debug helper
function logDebug(message, ...args) {
  console.log(`[${new Date().toISOString()}] ${message}`, ...args);
}

// Listen for tab removal to reset icon when Meet tabs are closed
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (activeMeetTabs.has(tabId)) {
    logDebug(`Meet tab ${tabId} was closed, removing from active tabs`);
    activeMeetTabs.delete(tabId);
    
    // If this was the last Meet tab, reset the icon
    if (activeMeetTabs.size === 0) {
      logDebug("No more Meet tabs active, resetting icon");
      globalMuteState.hasMeetTab = false;
      setGlobalBadge("", "#666666", "Disconnected");
    }
  }
});

// Initialization
chrome.runtime.onInstalled.addListener(() => {
  logDebug("Super Meet Mute installed!");
  // Initialize default settings
  chrome.storage.local.set({ muted: false });
  
  // Set up a global badge for all tabs
  chrome.action.setBadgeBackgroundColor({ color: "#666666" });
});

// Listen for connections from content scripts
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "meetmute-connection") {
    // Store the port's tab ID when a content script connects
    const tabId = port.sender.tab.id;
    console.log(`Content script connected in tab ${tabId}`);
    
    // Store the connection
    activeMeetTabs.set(tabId, port);
    
    // Update icon to show connected state
    chrome.action.setTitle({ tabId, title: "Connected to Meet" });
    
    // Listen for port disconnect
    port.onDisconnect.addListener(() => {
      logDebug(`Tab ${tabId} disconnected`);
      activeMeetTabs.delete(tabId);
      
      // If this was the last Meet tab, reset the icon
      if (activeMeetTabs.size === 0) {
        logDebug("No more Meet tabs active, resetting icon");
        globalMuteState.hasMeetTab = false;
        setGlobalBadge("", "#666666", "Disconnected");
      }
    });
    
    // Listen for messages from this port
    port.onMessage.addListener((message) => {
      logDebug(`Message from tab ${tabId}:`, message);
      
      // Update global mute state and update all tabs
      if (message.message === "muted") {
        // If this is the final state update, use the proper color
        if (message.finalState) {
          logDebug("Received final MUTED state, updating all tabs");
          globalMuteState.isMuted = true;
          globalMuteState.hasMeetTab = true;
          updateAllTabsBadge();
        }
      } else if (message.message === "unmuted") {
        // If this is the final state update, use the proper color
        if (message.finalState) {
          logDebug("Received final UNMUTED state, updating all tabs");
          globalMuteState.isMuted = false;
          globalMuteState.hasMeetTab = true;
          updateAllTabsBadge();
        }
      } else if (message.message === "disconnected") {
        // Only mark as disconnected if this was the last Meet tab
        if (activeMeetTabs.size <= 1) {
          globalMuteState.hasMeetTab = false;
          updateAllTabsBadge();
        }
      }
    });
  }
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab) {
    if (message.message === "content_script_loaded") {
      logDebug(`Content script loaded in tab ${sender.tab.id}`);
      sendResponse({ received: true });
    } else if (message.message === "muted" || message.message === "unmuted") {
      // Handle mute state updates from one-time messages as well
      logDebug(`Received one-time message from tab ${sender.tab.id}:`, message);
      
      if (message.finalState) {
        logDebug(`Updating global state based on one-time message: ${message.message}`);
        globalMuteState.isMuted = (message.message === "muted");
        globalMuteState.hasMeetTab = true;
        updateAllTabsBadge();
      }
      
      sendResponse({ received: true });
    }
  }
  return true; // Keep the message channel open for async response
});

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
  logDebug(`Command received: ${command}`);
  if (command === "toggle_mute") {
    simpleToggleMute(true); // true = treat like icon click to avoid flickering
  }
});

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  logDebug("Extension icon clicked in tab: " + tab.id);
  
  // Check if we have any active Meet tabs before trying to toggle
  if (activeMeetTabs.size === 0) {
    logDebug("No active Meet tabs, showing message");
    setGlobalBadge("!", "#FFC107", "No active Meet tabs"); // Yellow warning
    
    // Clear the warning after a few seconds
    setTimeout(() => {
      setGlobalBadge("", "#666666", "Disconnected");
    }, 3000);
    return;
  }
  
  // Skip the processing state and just toggle
  // This prevents the flickering effect
  simpleToggleMute(true); // true = from icon click
});

// Function to toggle mute
// Simple helper to set badge for all tabs
function setGlobalBadge(text, color, title) {
  try {
    // Set global badge first
    chrome.action.setBadgeText({ text: text });
    chrome.action.setBadgeBackgroundColor({ color: color });
    chrome.action.setTitle({ title: title });
    
    logDebug(`Set global badge to: ${text} with color ${color}`);
  } catch (error) {
    console.error("Error setting global badge:", error);
  }
}

// Simple toggle function
async function simpleToggleMute(fromIconClick = false) {
  try {
    // Get current state
    const result = await chrome.storage.local.get(["muted"]);
    const isMuted = result.muted;
    const newMutedState = !isMuted;
    
    logDebug(`Simple toggle from ${isMuted} to ${newMutedState}`);
    
    // Update storage
    await chrome.storage.local.set({ muted: newMutedState });
    
    // For icon clicks, we want to avoid flickering, so we'll update the badge only once
    // after the content script has had a chance to process the change
    if (!fromIconClick) {
      // Update badge immediately to expected state
      if (newMutedState) {
        setGlobalBadge("M", "#F44336", "Meet: Muted"); // Red
      } else {
        setGlobalBadge("U", "#4CAF50", "Meet: Unmuted"); // Green
      }
    }
    
    // Send message to content script
    sendMessageToContentScript({ action: "toggleMute", muted: newMutedState });
    
    // For icon clicks, wait a bit longer before updating the badge
    // This gives the content script time to process the change
    const verificationDelay = fromIconClick ? 300 : 500;
    
    // Double-check after a delay
    setTimeout(async () => {
      const checkResult = await chrome.storage.local.get(["muted"]);
      logDebug("Verification check:", checkResult.muted);
      
      // Update badge based on actual state
      if (checkResult.muted) {
        setGlobalBadge("M", "#F44336", "Meet: Muted"); // Red
      } else {
        setGlobalBadge("U", "#4CAF50", "Meet: Unmuted"); // Green
      }
    }, verificationDelay);
    
  } catch (error) {
    console.error("Error in simpleToggleMute:", error);
  }
}

// Update badge for all tabs based on global mute state - LEGACY FUNCTION
// Now we use setGlobalBadge instead
async function updateAllTabsBadge() {
  try {
    logDebug(`Legacy function called. Muted: ${globalMuteState.isMuted}, HasMeetTab: ${globalMuteState.hasMeetTab}`);
    
    if (globalMuteState.hasMeetTab) {
      // We have at least one Meet tab, show mute state globally
      const badgeText = globalMuteState.isMuted ? "M" : "U";
      const badgeColor = globalMuteState.isMuted ? "#F44336" : "#4CAF50";
      const title = globalMuteState.isMuted ? "Meet: Muted" : "Meet: Unmuted";
      
      setGlobalBadge(badgeText, badgeColor, title);
    } else {
      // No Meet tabs, clear badge globally
      setGlobalBadge("", "#666666", "Disconnected");
    }
  } catch (error) {
    console.error("Error updating badges:", error);
  }
}

// Update global mute state - only called when we're sure about the state
function updateGlobalMuteState(isMuted) {
  logDebug(`Updating global mute state to: ${isMuted}`);
  globalMuteState.isMuted = isMuted;
  globalMuteState.hasMeetTab = true;
  globalMuteState.lastUpdateTime = Date.now();
  
  // Update badge on all tabs immediately
  updateAllTabsBadge();
}

// Function to send a message to all active Meet tabs
function sendMessageToContentScript(message) {
  logDebug("Sending message to content scripts:", message);
  
  // First try to use the stored port connections
  if (activeMeetTabs.size > 0) {
    console.log(`Sending message to ${activeMeetTabs.size} active Meet tabs`);
    for (const [tabId, port] of activeMeetTabs.entries()) {
      try {
        port.postMessage(message);
      } catch (error) {
        console.error(`Error posting message to tab ${tabId}:`, error);
        // Remove the port if it's invalid
        activeMeetTabs.delete(tabId);
      }
    }
    return;
  }
  
  // Fallback: try to find Meet tabs and send messages
  chrome.tabs.query({ url: "https://meet.google.com/*" })
    .then(tabs => {
      if (tabs.length === 0) {
        console.log("No Google Meet tabs found");
        return;
      }
      
      console.log(`Found ${tabs.length} Google Meet tabs, attempting to send messages`);
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, message)
          .catch(error => {
            console.error(`Error sending message to tab ${tab.id}:`, error);
          });
      });
    })
    .catch(error => {
      console.error("Error querying tabs:", error);
    });
}