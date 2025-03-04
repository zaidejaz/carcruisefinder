const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;
const path = require('path');

// Add stealth plugin to bypass detection
puppeteer.use(StealthPlugin());

async function scrapeStatesAndRegions() {
  const browser = await puppeteer.launch({
    headless: false, // Set to true for production
    defaultViewport: null,
  });

  try {
    const page = await browser.newPage();
    
    // Navigate to the homepage
    await page.goto('https://carcruisefinder.com/', {
      waitUntil: 'networkidle0',
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

    console.log(states)
    // Prepare results object
    const statesWithRegions = [];

    // Iterate through states and get their regions
    for (const state of states) {
      console.log(`Scraping regions for ${state.name}`);

      // Select the state
      await page.select('#cat', state.id);

      // Add a more reliable wait method
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

      // Extract regions for this state
      const regions = await page.evaluate(() => {
        const regionSelect = document.getElementById('region-dropdown');
        return Array.from(regionSelect.options)
          .filter(option => 
            option.value !== '' && 
            option.value !== '/alaska-car-events/events/category/alaska-car-shows/'
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

      // Use a Promise-based delay instead of waitForTimeout
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Save results to JSON file
    const outputPath = path.join(__dirname, 'states_and_regions.json');
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