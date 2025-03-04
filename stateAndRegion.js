const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;
const path = require('path');

// Add stealth plugin to bypass detection
puppeteer.use(StealthPlugin());

async function simulateHumanClick(page, selector) {
  const element = await page.$(selector);
  if (!element) return;

  // Get the bounding box of the element
  const box = await element.boundingBox();

  // Move mouse to a random point within the element
  await page.mouse.move(
    box.x + box.width * Math.random(),
    box.y + box.height * Math.random()
  );

  // Simulate human-like clicking
  await page.mouse.down();
  await page.waitForTimeout(Math.random() * 50 + 50); // Small random delay
  await page.mouse.up();
}

async function scrapeStatesAndRegions() {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
  });

  try {
    const page = await browser.newPage();
    
    // Navigate to the homepage
    await page.goto('https://carcruisefinder.com/', {
      waitUntil: 'load',
      timeout: 60000
    });

    // Wait for the state dropdown to be available
    await page.waitForSelector('#cat');

    // Extract states
    const states = await page.evaluate(() => {
      const stateSelect = document.getElementById('cat');
      return Array.from(stateSelect.options)
        .filter(option => option.value !== '')
        .map(option => ({
          id: option.value,
          name: option.text
        }));
    });

    const statesWithRegions = [];
    
    // Initial click on state dropdown to "wake it up"
    await simulateHumanClick(page, '#cat');
    await page.waitForTimeout(1000);

    // Iterate through states and get their regions
    for (const state of states) {
      console.log(`Scraping regions for ${state.name}`);

      // Simulate clicking and selecting the state
      await simulateHumanClick(page, '#cat');
      await page.evaluate((stateId) => {
        const select = document.getElementById('cat');
        select.value = stateId;
        // Trigger change event
        const event = new Event('change', { bubbles: true });
        select.dispatchEvent(event);
      }, state.id);

      // Wait for potential dynamic loading
      await page.waitForTimeout(1000);

      // Simulate clicking on region dropdown
      await simulateHumanClick(page, '#region-dropdown');
      await page.waitForTimeout(500);

      // Wait for region dropdown to populate
      await page.evaluate(() => {
        return new Promise((resolve) => {
          const checkRegionDropdown = () => {
            const regionSelect = document.getElementById('region-dropdown');
            if (regionSelect && regionSelect.options.length > 1) {
              resolve();
            } else {
              setTimeout(checkRegionDropdown, 100);
            }
          };
          checkRegionDropdown();
        });
      });

      // Extract ONLY the "All X Car Shows" region
      const regions = await page.evaluate(() => {
        const regionSelect = document.getElementById('region-dropdown');
        return Array.from(regionSelect.options)
          .filter(option => 
            option.text.toLowerCase().includes('all') && 
            option.text.toLowerCase().includes('car shows') &&
            option.value !== ''
          )
          .map(option => ({
            name: option.text,
            url: option.value
          }));
      });

      // Add to results
      statesWithRegions.push({
        ...state,
        regions: regions
      });

      // Random delay between states to appear more human-like
      await page.waitForTimeout(Math.random() * 1000 + 500);
    }

    // Save results to JSON file
    const outputPath = path.join(__dirname, 'states_all_car_shows.json');
    await fs.writeFile(outputPath, JSON.stringify(statesWithRegions, null, 2));

    console.log(`Scraping complete. Results saved to ${outputPath}`);

    return statesWithRegions;

  } catch (error) {
    console.error('An error occurred during scraping:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Export the function for use in other parts of the application
module.exports = scrapeStatesAndRegions;

// If run directly, execute the scraping
if (require.main === module) {
  scrapeStatesAndRegions()
    .then(results => console.log('Scraping completed successfully'))
    .catch(error => console.error('Scraping failed:', error));
}