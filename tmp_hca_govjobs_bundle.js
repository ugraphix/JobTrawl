/* Minification failed. Returning unminified contents.
(21,69-70): run-time error JS1100: Expected ',': =
(1466,49-50): run-time error JS1195: Expected expression: >
(1476,34-35): run-time error JS1195: Expected expression: )
(1582,83-84): run-time error JS1195: Expected expression: >
(1584,50-51): run-time error JS1195: Expected expression: )
(1591,41-45): run-time error JS1006: Expected ')': else
(1591,41-45): run-time error JS1034: Unmatched 'else'; no 'if' defined: else
(1592,81-82): run-time error JS1195: Expected expression: >
(1594,45-46): run-time error JS1002: Syntax error: }
(1598,45-46): run-time error JS1002: Syntax error: }
(1602,45-46): run-time error JS1002: Syntax error: }
(1605,60-61): run-time error JS1197: Too many errors. The file might not be a JavaScript file: ;
(1585,49-55): run-time error JS1300: Strict-mode does not allow assignment to undefined variables: marker
 */
/* Minification failed. Returning unminified contents.
(6,69-70): run-time error JS1100: Expected ',': =
(1451,49-50): run-time error JS1195: Expected expression: >
(1461,34-35): run-time error JS1195: Expected expression: )
(1567,83-84): run-time error JS1195: Expected expression: >
(1569,50-51): run-time error JS1195: Expected expression: )
(1576,41-45): run-time error JS1006: Expected ')': else
(1576,41-45): run-time error JS1034: Unmatched 'else'; no 'if' defined: else
(1577,81-82): run-time error JS1195: Expected expression: >
(1579,45-46): run-time error JS1002: Syntax error: }
(1583,45-46): run-time error JS1002: Syntax error: }
(1587,45-46): run-time error JS1002: Syntax error: }
(1590,60-61): run-time error JS1197: Too many errors. The file might not be a JavaScript file: ;
(1570,49-55): run-time error JS1300: Strict-mode does not allow assignment to undefined variables: marker
 */
(function (window, undefined) {
    var userSettingsService = namespace('AgencyPages').userSettingsService;

    var maxMobileScreenWidth = 767;

    function saveUserAgencySettings(isListView, saveDefaultPageView = false) {

        var currentPageUserSettings = userSettingsService.getSettings();

        if (!currentPageUserSettings) {
            currentPageUserSettings = {};
        }

        isListView = (isListView !== undefined)
            ? isListView
            : true;

        if (saveDefaultPageView) {
            if (currentPageUserSettings.isListViewDefaultForPage == isListView)
                return;
            else
                currentPageUserSettings.isListViewDefaultForPage = isListView
        }
        else
            currentPageUserSettings.isListView = isListView;
        userSettingsService.setSettings(currentPageUserSettings);
    }

    function ListGridViewService() {
        var self = this;

        self.isGridEnabled = false;

        self.showList = function(changeUserSettings, forceUpdate) {
            changeUserSettings = changeUserSettings !== undefined
                ? changeUserSettings
                : true;

            forceUpdate = forceUpdate !== undefined
                ? forceUpdate
                : false;

            if (self.isGridEnabled || forceUpdate) {
                self.isGridEnabled = false;

                $('ul.search-results-listing-container').removeClass('hidden');
                $('div.search-results-grid-container').addClass('hidden');
                $('div#eligible-list-result-container').removeClass('hidden');

                $('#action-list-view').parent().addClass('active');
                $('#action-grid-view').parent().removeClass('active');

                $(document).trigger('layoutUpdated');

                if (changeUserSettings) {
                    saveUserAgencySettings(true);
                }
            }
        };

        self.showGrid = function(changeUserSettings, forceUpdate) {
            changeUserSettings = changeUserSettings !== undefined
                ? changeUserSettings
                : true;

            forceUpdate = forceUpdate !== undefined
                ? forceUpdate
                : false;

            if (!self.isGridEnabled || forceUpdate) {
                self.isGridEnabled = true;

                $('ul.search-results-listing-container').addClass('hidden');
                $('div.search-results-grid-container').removeClass('hidden');
                $('div#eligible-list-result-container').removeClass('hidden');

                $('#action-list-view').parent().removeClass('active');
                $('#action-grid-view').parent().addClass('active');

                $(document).trigger('layoutUpdated');

                if (changeUserSettings) {
                    saveUserAgencySettings(false);
                }
            }
        };

        self.showCurrentViewRegardingUserSettings = function (pageSettings, forceUpdate) {
            if ($(window).width() > maxMobileScreenWidth) {
                if (pageSettings && pageSettings.isListView !== undefined) {
                    if (pageSettings.isListView) {
                        self.showList(false, forceUpdate);
                    } else {
                        self.showGrid(false, forceUpdate);
                    }
                }
                else if (pageSettings && pageSettings.isListViewDefaultForPage !== undefined) {
                    if (pageSettings.isListViewDefaultForPage) {
                        self.showList(false, forceUpdate);
                    } else {
                        self.showGrid(false, forceUpdate);
                    }
                }
            }
            else {
                self.showList(false, forceUpdate);
            }
        };

        self.updateView = function (forceUpdate) {
            self.showCurrentViewRegardingUserSettings(userSettingsService.getSettings(), forceUpdate);
        };

        self.saveDefaultPageViewSettings = function (isListView) {
            saveUserAgencySettings(isListView, true);
        }       
    }

    namespace('AgencyPages').listGridViewService = new ListGridViewService();
})(window);;
(function (window, undefined) {

    var transitionEvents = "transitionend" //major current browsers
        + " webkitTransitionEnd" //safari, chrome
        + " MSTransitionEnd"; //old IE 

    var applicationReviewPrintUrl = '/Applications/Print/';

    var $body = $('body');

    //todo: declare all selectors as constants
    var CachedJobInfoSource = function () {
        var jobInfoEndpoint = '/careers/jobInfo/agencyJobDetails/';
        var self = this;

        var cache = {};

        self.get = function (id, departmentFolderName) {
            if (cache[id]) {
                return (new $.Deferred()).resolve(cache[id]).promise();
            } else {
                var departmentQuery = departmentFolderName ? '?departmentFolder=' + departmentFolderName : '';
                var isSubmittedApplicationPageQuery = departmentFolderName ? '&isSubmittedApplicationPage=true' : '?isSubmittedApplicationPage=true';
                return $.get(jobInfoEndpoint + id + departmentQuery + isSubmittedApplicationPageQuery, function (data) {
                    cache[id] = data;
                });
            }
        };
    };

    var submittedApplicationFlyoutConstructor = function (options) {

        var content = $('#submitted-application-flyout-content');
        var $openedNotification = content.find('.opened-notification');
        var $loadedNotification = content.find('.loaded-notification');
        var applicationsPageTabs = agencyPages.applicationsPage.applicationsPageTabs;
        var initialUrl = agencyPages.applicationsPage.getApplicationsTabUrl(applicationsPageTabs.submitted);
        var applicationBaseUrl = null;
        var originalPageTitle = window.document.title;

        var self = window.Flyout.call(this, {
            showOverlay: true,
            disableBodyScroll: true,
            container: $body,
            content: content,
            closeButton: true,
            //todo: rename to job-flyout, also in agency specific razor-generated css
            wrapperClass: 'new-job-flyout'
        }) || this;

        var $jobDetailsTab = self.$wrapper.find('.entity-details-tab'),
            $jobApplyTab = self.$wrapper.find('.application-review-tab'),
            $appViewContainer = self.$wrapper.find('.application-view-container');

        self.tabs = {
            jobDetailsTab: {
                id: 1,
                urlPart: 'jobdetails'
            },
            applicationTab: {
                id: 2,
                urlPart: 'application'
            }
        };

        var baseClose = self.close;
        self.close = function () {
            //Using .on() and .off() instead of .one() because if there are multiple events used in one() with same handler, only for the triggered event, the binding is removed
            self.$wrapper.on(transitionEvents, function () {
                $jobDetailsTab.removeClass('active');
                $jobApplyTab.addClass('active');
                self.$wrapper.off(transitionEvents);
            });

            namespace('AgencyPages').router.navigate(initialUrl, false, false, null, null, true);
            baseClose();
            self.activeJobId = null;
            self.activeTab = null;

            window.document.title = originalPageTitle;
        };

        self.activeJobId = null;
        self.activeJobTitle = null;
        self.activeTab = null;
        self.activeJobApplicationId = null;

        var jobInfoSource = new CachedJobInfoSource();

        self.$wrapper
            .find('.close-button')
            .add(self.$overlay)
            .off('click').on('click', self.close);

        self.$wrapper.find('.flyout-switch-buttons a').click(function (event) {

            var tab = $(event.currentTarget).data('tab-type');

            if (tab === self.tabs.jobDetailsTab.id) {
                $('#applications-container-link').attr('tabindex', '-1');
                setActiveTab(self.tabs.jobDetailsTab.id);
                namespace('AgencyPages').router.navigate(applicationBaseUrl + '/' + self.tabs.jobDetailsTab.urlPart, false, null, null, null, true);
                gJobs.skipToContentService.showOnNextTab();
                let tablists = document.querySelectorAll('[role=tablist]');
                for (let i = 0; i < tablists.length; i++) {
                    new TabsManual(tablists[i]);
                }
                $('#job-info').attr('tabindex', '0');
                $('#job-app').attr('tabindex', '-1');

                let desc_li = $('.description');
                let questions_li = $('.questions');
                let benefits_li = $('.benefits');
                let descButton = $('#description');
                let benefitsButton = $('#benefits');
                let questionsButton = $('#questions');
                if (desc_li) {
                    let isDescActive = desc_li.hasClass('active');
                    if (isDescActive == true) {
                        descButton.attr('tabindex', '0');
                        questionsButton.attr('tabindex', '-1');
                        benefitsButton.attr('tabindex', '-1');
                    }
                }
                if (benefits_li) {
                    let isBenefitsActive = benefits_li.hasClass('active');
                    if (isBenefitsActive == true) {
                        descButton.attr('tabindex', '-1');
                        questionsButton.attr('tabindex', '-1');
                        benefitsButton.attr('tabindex', '0');
                    }
                }
                if (questions_li) {
                    let isQuestionsActive = questions_li.hasClass('active');
                    if (isQuestionsActive == true) {
                        descButton.attr('tabindex', '-1');
                        questionsButton.attr('tabindex', '0');
                        benefitsButton.attr('tabindex', '-1');
                    }
                }
            } else {
                $('#applications-container-link').attr('tabindex', '-1');
                setActiveTab(self.tabs.applicationTab.id);
                namespace('AgencyPages').router.navigate(applicationBaseUrl + '/' + self.tabs.applicationTab.urlPart, false, null, null, null, true);
                $('#job-info').attr('tabindex', '-1');
                $('#job-app').attr('tabindex', '0');
                $('.jobapp').focus();
            }
        });

        self.$wrapper.find('.flyout-switch-buttons a').keydown(function (event) {
            if (event.key == "Enter") {
                var tab = $(event.currentTarget).data('tab-type');

                if (tab === self.tabs.jobDetailsTab.id) {

                    setActiveTab(self.tabs.jobDetailsTab.id);
                    namespace('AgencyPages').router.navigate(applicationBaseUrl + '/' + self.tabs.jobDetailsTab.urlPart, false, null, null, null, true);
                    gJobs.skipToContentService.showOnNextTab();
                    let tablists = document.querySelectorAll('[role=tablist]');
                    for (let i = 0; i < tablists.length; i++) {
                        new TabsManual(tablists[i]);
                    }
                    $('#job-info').focus();
                    $('#job-info').attr('tabindex', '0');
                    $('#job-app').attr('tabindex', '-1');

                    let desc_li = $('.description');
                    let questions_li = $('.questions');
                    let benefits_li = $('.benefits');
                    let descButton = $('#description');
                    let benefitsButton = $('#benefits');
                    let questionsButton = $('#questions');
                    if (desc_li) {
                        let isDescActive = desc_li.hasClass('active');
                        if (isDescActive == true) {
                            descButton.attr('tabindex', '0');
                            questionsButton.attr('tabindex', '-1');
                            benefitsButton.attr('tabindex', '-1');
                        }
                    }
                    if (benefits_li) {
                        let isBenefitsActive = benefits_li.hasClass('active');
                        if (isBenefitsActive == true) {
                            descButton.attr('tabindex', '-1');
                            questionsButton.attr('tabindex', '-1');
                            benefitsButton.attr('tabindex', '0');
                        }
                    }
                    if (questions_li) {
                        let isQuestionsActive = questions_li.hasClass('active');
                        if (isQuestionsActive == true) {
                            descButton.attr('tabindex', '-1');
                            questionsButton.attr('tabindex', '0');
                            benefitsButton.attr('tabindex', '-1');
                        }
                    }
                    $('#applications-container-link').attr('tabindex', '-1');
                } else {
                    $('#applications-container-link').attr('tabindex', '-1');
                    setActiveTab(self.tabs.applicationTab.id);
                    namespace('AgencyPages').router.navigate(applicationBaseUrl + '/' + self.tabs.applicationTab.urlPart, false, null, null, null, true);
                    $('#job-info').attr('tabindex', '-1');
                    $('#job-app').attr('tabindex', '0');
                    $('.jobapp').focus();
                }
            }
        });

        var $scrollableContainers = $jobApplyTab.find('.application-container').add($jobDetailsTab.find('.entity-info'));

        AgencyPages.scrollableContainerAdjuster.addHeaderShadowOnScrolling($scrollableContainers);

        self.showJob = function (jobInfo) {
            $openedNotification.empty();
            var tabTitle = '';
            applicationBaseUrl = initialUrl + '/' + jobInfo.id + '/' + jobInfo.jobApplicationId;

            if (jobInfo.tab === undefined) {
                jobInfo.tab = self.tabs.applicationTab.id;
            }

            if (jobInfo.id === self.activeJobId) {
                if (jobInfo.tab !== self.activeTab) {
                    // The same application, need only to set flyout tab.
                    setActiveTab(jobInfo.tab);
                }
                return;
            }

            if (jobInfo.tab === self.tabs.applicationTab.id) {
                tabTitle = 'Application';
            } else {
                tabTitle = 'Job Details';
            }

            self.activeJobId = jobInfo.id;
            setActiveTab(jobInfo.tab);
            self.activeJobTitle = jobInfo.title;
            self.activeJobApplicationId = jobInfo.jobApplicationId;

            $openedNotification.text(jobInfo.title + ' flyout is opened. ' + tabTitle + ' tab has been activated');

            self.open($openedNotification);

            $jobApplyTab.find('h1.entity-title').text(jobInfo.title);

            //JOB
            var $jobInfoContainer = self.$wrapper.find('.entity-info').empty();
            var departmentFolderName = namespace('AgencyPages').pageInfoService.getCurrentDepartmentFolderName();

            jobInfoSource.get(jobInfo.id, departmentFolderName).done(function (data) {
                $jobInfoContainer.html(data);

                self.activeJobTitle = $jobInfoContainer.find('.summary .title').text();
                $jobApplyTab.find('h1.entity-title').text(self.activeJobTitle);

                //set print button href
                var printingUrl = $jobInfoContainer.find('.summary').data('printing-url');
                $jobDetailsTab.find('a.print-button').attr('href', printingUrl);

                OnlineApp.Helpers.popoverHelper.initializePopover(content, 'span[data-toggle="popover"]');
                let tablists = document.querySelectorAll('[role=tablist]');
                for (let i = 0; i < tablists.length; i++) {
                    new TabsManual(tablists[i]);
                }
            });

            //APPLICATION
            $jobApplyTab.removeClass('hide');
            $.ajax({
                url: AgencyPages.routePrefix + '/Applications/ApplicationView',
                type: 'GET',
                contentType: 'text/html',
                cache: false
            })
                .done(function (view) {

                    let tablists = document.querySelectorAll('[role=tablist]');
                    for (let i = 0; i < tablists.length; i++) {
                        new TabsManual(tablists[i]);
                    }
                    $('#applications-container-link').attr('tabindex', '-1');
                    var $appReviewPrintLink = $jobApplyTab.find('.header-buttons').find('a.print-button');
                    $appReviewPrintLink.attr('href', applicationReviewPrintUrl + jobInfo.jobApplicationId);

                    // Insert received HTML into container
                    var getAppSettingsUrl = "/api/applicationTemplate/GetAppSettings";
                    $appViewContainer.html(view);

                    // Remove content on closing flyout.
                    // New subscription because of incomplete application flyout.
                    //$(document).one(Events.CommonEventsNames.TryCloseFlyout, function () {
                    //    appViewContainer.empty();
                    //});


                    //todo: clean up this code and categorize it well
                    // Get JobApplication data
                    $.ajax({
                        type: 'GET',
                        url: '/api/jobapplication/getJobApplication',
                        data: {
                            jobApplicationId: jobInfo.jobApplicationId
                        }
                    }).done(function (jobApplicationData) {
                        if (!jobApplicationData) {
                            $appViewContainer.find(".flyout-spinner").hide();
                            toastr.warning("Sorry.. Nothing to show");
                            return;
                        }
                        let tablists = document.querySelectorAll('[role=tablist]');
                        for (let i = 0; i < tablists.length; i++) {
                            new TabsManual(tablists[i]);
                        }
                        $('#applications-container-link').attr('tabindex', '-1');
                        // Get Settings for specified Job
                        $.ajax({
                            type: "GET",
                            url: getAppSettingsUrl,
                            cache: false,
                            data: { jobId: jobInfo.id }
                        }).fail(function () {
                            toastr.warning(Resources.NotificationMessages.LoadTemplateFail);
                        })
                            .done(function (appSettings) {
                                // process template here

                                //if (!appSettings) {
                                //    toastr.warning(Resources.NotificationMessages.LoadTemplateFail);
                                //    return;
                                //}

                                var vm = OnlineApp.ViewModels;
                                OnlineApp.ViewModels.applicationViewModel.definitionsViewModel = new vm.DefinitionsViewModel(true);
                                var applicationReviewViewModel = new vm.ApplicationReviewViewModel();

                                // update jobApplicationData
                                applicationReviewViewModel.fromDataModel(jobApplicationData, appSettings);

                                // apply ko bindings only for specific region on a page
                                var applicationView = $appViewContainer.find('.application-view');
                                ko.applyBindings(applicationReviewViewModel,
                                    applicationView.get(0));

                                //if (!appReviewTemplatesLoading) {
                                $appViewContainer.find(".flyout-spinner").hide();
                                //}
                            });
                    });
                })
                .fail(function () {
                    toastr.warning(Resources.NotificationMessages.ServerConnectionFailed);
                });
        };

        self.$wrapper
            .find('a[data-toggle="popover"], span[data-toggle="popover"]')
            .popover();

        function setActiveTab(tabNumber) {
            if (tabNumber === self.tabs.jobDetailsTab.id) {
                $jobDetailsTab.addClass('active');
                $jobApplyTab.removeClass('active');
                self.activeTab = self.tabs.jobDetailsTab.id;
                window.document.title = originalPageTitle + ' – Job Details';
                gJobs.screenReadersService.setAriaLiveNotification("Job Details tab selected");
            } else {
                $jobDetailsTab.removeClass('active');
                $jobApplyTab.addClass('active');
                self.activeTab = self.tabs.applicationTab.id;
                window.document.title = originalPageTitle + ' – Application';
                gJobs.screenReadersService.setAriaLiveNotification("Application tab selected");
            }
        }
    };

    var scheduleExamFlyoutConstructor = function (options) {

        var content = $('#schedule-exam-flyout-content'),
            scheduleExamButton = $('#applications-container .schedule-exam-button');

        var self = window.Flyout.call(this, {
            showOverlay: true,
            disableBodyScroll: true,
            container: $body,
            content: content,
            //todo: rename to job-flyout, also in agency specific razor-generated css
            wrapperClass: 'schedule-exam-flyout'
        }) || this;

        var baseClose = self.close,
            baseOpen = self.open;

        var NO_SLOTS_MESSAGE = 'We’re sorry, there are no available time slots. Please check back soon.';

        self.close = function () {
            baseClose();
            self.activeJobId = null;
            self.activeTab = null;
            scheduleExamButton.removeAttr('tabindex');
        };

        self.open = function ($focusTarget) {
            baseOpen($focusTarget);
            scheduleExamButton.attr('tabindex', -1);
        };

        self.activeJobId = null;
        self.activeJobTitle = null;
        self.activeTab = null;

        var $closeButon = self.$wrapper.find('.close-button');

        $closeButon.click(function () {
            self.close();
        });

        self.showSchedule = function ($this, title, examData) {
            //Set job subtitle
            self.$wrapper.find('.flyout-tab-header .subtitle').text(title);

            agencyPages.applicationsPage.stateChangeHandler = function () {

                var state = this.da();
                if (state === 'confirmed') {
                    var dateTime = scheduleExamViewModel
                        .selectedExam()
                        .selectedTimeSlot()
                        .displayDate;
                    $this.find('.exam-date-text').html(dateTime);
                    $this.find('.update-exam').removeClass('hide');
                    $this.find('.schedule-exam').addClass('hide');
                }
                else if (state === 'scheduling') {
                    $this.find('.update-exam').addClass('hide');
                    $this.find('.schedule-exam').removeClass('hide');
                }
            };
            agencyPages.applicationsPage.scheduleExamViewModel.state('loading');
            var promise = OnlineApp.Services.dataService.exam.get(null, examData);
            promise
                .always(function () {
                    if (agencyPages.applicationsPage.currentExamSubscription) {
                        agencyPages.applicationsPage.currentExamSubscription.dispose();
                        agencyPages.applicationsPage.currentExamSubscription = null;
                    }
                })
                .done(function (data) {
                    $.extend(data, examData);

                    var scheduleExamViewModel = agencyPages.applicationsPage.scheduleExamViewModel;
                    scheduleExamViewModel.fromDataModel(data);

                    if (scheduleExamViewModel.state() === 'no-time-slots') {
                        gJobs.screenReadersService
                            .setAriaLiveNotification(NO_SLOTS_MESSAGE);
                    }

                    agencyPages.applicationsPage.currentExamSubscription = scheduleExamViewModel.state.subscribe(agencyPages.applicationsPage.stateChangeHandler);
                });

            gJobs.skipToContentService.showOnNextTab();

            var openedNotification = content.find('.flyout-tab-header .title').data('schedule-appointment-text') +
                ' flyout is opened.';

            var $openedNotification =
                content.find('.opened-notification')
                    .text(openedNotification);

            self.open();
        };

        var scheduleExamViewModel = agencyPages.applicationsPage.scheduleExamViewModel;
    };

    var offerFlyoutConstructor = function (options) {
        var $content = $('#offer-flyout-content');
        var $responsiveSignature = $('#responsive-signature');
        var originalPageTitle = window.document.title;
        var initialUrl = agencyPages.applicationsPage.getApplicationsTabUrl(agencyPages.applicationsPage.applicationsPageTabs.submitted);

        var self = window.Flyout.call(this, {
            showOverlay: true,
            disableBodyScroll: true,
            container: $body,
            content: $content,
            closeButton: true,
            wrapperClass: 'offer-flyout'
        }) || this;

        var baseClose = self.close;

        self.close = function () {
            window.document.title = originalPageTitle;
            namespace('AgencyPages').router.navigate(initialUrl, false, false, null, null, true);
            baseClose();
        }

        self.showOffer = function (offerData) {
            OnlineApp.Services.dataService.offer.get(offerData.offerId)
                .done(function (data) {
                    window.document.title = originalPageTitle + ' – Offer Letter';
                    $.extend(data, offerData);
                    var OfferViewModel = agencyPages.applicationsPage.offerViewModel;

                    ko.cleanNode($responsiveSignature[0]);
                    ko.applyBindings(OfferViewModel.signatureViewModel, $responsiveSignature[0]);

                    OfferViewModel.fromDataModel(data);

                    $content.find('.popover-trigger').popover();

                    $closeButton = self.$wrapper.find('.close-button');
                    $closeButton
                        .removeClass('hide')
                        .add(self.$overlay)
                        .off('click')
                        .on('click', self.close);

                    gJobs.skipToContentService.showOnNextTab();

                    var $openedNotification =
                        $content.find('.opened-notification')
                            .text('View Offer flyout is opened.');

                    self.open($openedNotification);
                })
                .fail(function () {
                    toastr.error(Resources.NotificationMessages.EncounteredProblem);
                });
        };
    };

    var canvassFlyoutConstructor = function (options) {
        var $content = $('#canvass-flyout-content');
        var $responsiveSignature = $('#responsive-signature');
        var originalPageTitle = window.document.title;
        var initialUrl = namespace('agencyPages') && agencyPages.applicationsPage ?
            agencyPages.applicationsPage.getApplicationsTabUrl(agencyPages.applicationsPage.applicationsPageTabs.submitted) :
            namespace('AgencyPages').pageInfoService.getCurrentInitialUrl();

        var self = window.Flyout.call(this, {
            showOverlay: true,
            disableBodyScroll: true,
            container: $body,
            content: $content,
            closeButton: true,
            wrapperClass: 'canvass-flyout'
        }) || this;

        var baseClose = self.close;

        self.showCanvass = function (canvassData) {
            OnlineApp.Services.canvassFlyoutService.getCanvassForm(canvassData.canvassFormId)
                .then(function (data) {
                    window.document.title = originalPageTitle + ' – Canvass Form';

                    $.extend(data, canvassData);

                    var CanvassViewModel = agencyPages.canvassViewModel;
                    ko.cleanNode($content[0]);
                    ko.cleanNode($responsiveSignature[0])

                    OnlineApp.Services.canvassFlyoutService.setupCanvassFlyout(data.description, data.isReadOnly);

                    ko.applyBindings(CanvassViewModel, $content[0]);
                    ko.applyBindings(CanvassViewModel.signatureViewModel, $responsiveSignature[0]);
                    CanvassViewModel.fromDataModel(data);

                    $content.find('.popover-trigger').popover();

                    $closeButton = self.$wrapper.find('.close-button');
                    $closeButton
                        .removeClass('hide')
                        .add(self.$overlay)
                        .off('click')
                        .on('click', self.close);

                    gJobs.skipToContentService.showOnNextTab();

                    var $openedNotification =
                        $content.find('.opened-notification')
                            .text('View Canvass form flyout is opened.');

                    self.open($openedNotification);
                })
                .fail(function (error) {
                    toastr.error(error.responseJSON && error.responseJSON.message || Resources.NotificationMessages.EncounteredProblem);
                });
        };

        self.close = function () {
            window.document.title = originalPageTitle;
            namespace('AgencyPages').router.navigate(initialUrl, false, false, null, null, true);
            baseClose();
        }
    };    
    window.SubmittedApplicationFlyout = submittedApplicationFlyoutConstructor;
    window.ScheduleExamFlyout = scheduleExamFlyoutConstructor;
    window.OfferFlyout = offerFlyoutConstructor;
    window.CanvassFlyout = canvassFlyoutConstructor;
})(window);;
(function (window, undefined) {
    'use strict';

    var SEARCH_AGENCY_JOBS_URL = AgencyPages.routePrefix + '/home/index';
    var MAX_CATEGORIES_LENGTH = 120;
    var SCROLL_TOP = 0;
    var JOBS_PER_PAGE = 10;

    var JOB_DESCRIPTION_CLAMP_LINE_COUNT = 2;

    var jobListContainerSelector = '#job-list-container';

    var jobsContainer = $(jobListContainerSelector);
    var searchInput = $('input.form-control');
    var actionListView = $('#action-list-view');
    var actionGridView = $('#action-grid-view');
    var overlay = $('#job-list-overlay');
    var mapOverlay = $('#map-overlay');
    var searhContainer = $('#manage-bar');
    var searchForm = searhContainer.find('.search-form');
    var numberFound = $('#number-found-items');
    var keywordSearchInput = searhContainer.find('#keyword-search-input');
    var buttonLink = $('button.btn.btn-link');
    var keywords = '';
    var sort = null;
    var filters = null;
    var jobZipCodes = [];
    var page = null;
    var filterflyout = undefined;
    var defaultSortingOrder = null;
    var isFlyTo = false;
    var globalMap = null;
    var pageInfoService = namespace('AgencyPages').pageInfoService;
    var userSettingsService = namespace('AgencyPages').userSettingsService;
    var listGridViewService = namespace('AgencyPages').listGridViewService;

    var initialUrl = pageInfoService.getCurrentInitialUrl();
    var maxMobileScreenWidth = 767;
    var coordinates = '';
    var co_ords = [];
    var isOpenPopup = false;
    var isMapMobile = false;
    var isSingleMarkerClicked = false;
    var clusterId = '';
    var mapJobsCount = 0;
    var isLinkOpenFromDesktopMapPopUp = false;
    var isLinkOpenFromMobileMapPopUp = false;
    var mapHighlightLatLong = '';
    var mapHighlightJobId = '';

    // Cuurent url params for jobs.
    var currentParams = {};

    function clampJobDescriptions() {
        jobsContainer.find('.search-results-listing-container .list-item .list-entry')
            .each(function () {
                clamp(this, JOB_DESCRIPTION_CLAMP_LINE_COUNT);
            });
    }

    function initFilterFlyout() {
        var page = searhContainer.data('page');
        filterflyout = new FilterFlyout(page);

        $('#filter-options').on('click', '.filter-options-link', function (event) {
            $('body .popover').css('display', 'none');

            var $el = $(this),
                panelType = $el.data('panelType');

            filterflyout.showFilterPanel(panelType, keywords, true);
            event.preventDefault();

            $(document).on(Events.CommonEventsNames.FlyoutClosing, function () {
                OnlineApp.Services.tabIndexService.restoreTabIndex();
            });
        });
    }

    function initCanvassFlyout() {
        var canvassFlyout = new CanvassFlyout();
        AgencyPages.canvassFlyout = canvassFlyout;

        var canvassViewModel = new OnlineApp.ViewModels.CanvassViewModel();
        var $container = $('#canvass-flyout-content');
        var $responsiveSignature = $('#responsive-signature');

        if ($container.length > 0) {
            ko.cleanNode($responsiveSignature[0]);
            ko.applyBindings(canvassViewModel, $container.get(0));
            ko.applyBindings(canvassViewModel.signatureViewModel, $responsiveSignature[0]);
        }

        namespace('agencyPages').canvassViewModel = canvassViewModel;
    }

    //todo take object
    function loadJobs(jobsContainer, jobtitle, page, sort, filters, loadMap) {

        showOverlay();

        coordinates = '';
        // Save current parameters.
        currentParams = {
            jobtitle: jobtitle,
            page: parseInt(page),
            sort: sort,
            filters: filters
        };

        var params = undefined;

        let filterAction = [];

        var agencyFolderName = pageInfoService.getCurrentAgencyFolderName();

        var departmentFolderName = pageInfoService.getCurrentDepartmentFolderName();

        if (agencyFolderName || jobtitle || page || sort || filters || isPromotionalJobs() || isTransferJobs()) {

            params = '?';

            if (agencyFolderName) {
                if (params != '?') {
                    params += '&';
                }
                params += 'agency=' + encodeURIComponent(agencyFolderName);
            }

            if (departmentFolderName) {
                if (params != '?') {
                    params += '&';
                }
                params += 'departmentFolder=' + encodeURIComponent(departmentFolderName);
            }

            if (jobtitle) {
                if (params != '?') {
                    params += '&';
                }

                params += 'keyword=' + encodeURIComponent(jobtitle);
                filterAction.push('Jobs Searched');
            }

            if (page) {
                if (params != '?') {
                    params += '&';
                }

                params += 'page=' + encodeURIComponent(page);

            }

            if (sort) {
                if (params != '?') {
                    params += '&';
                }


                var sortParts = sort.split('|');
                var sortField = sortParts[0];
                var sortOrder = sortParts[1];

                params += 'sort=' + encodeURIComponent(sortField) + '&isDescendingSort=' + encodeURIComponent(sortOrder === 'Descending');

            }

            if (isMapsOptionSelected()) {
                var jobzipcodes = "";
                if (jobZipCodes.length == 0) {
                    jobZipCodes.push("-1");
                }

                for (i = 0; i < jobZipCodes.length; i++) {
                    if (params != '?') {
                        params += '&';
                    }

                    params += 'jobZipCodes=' + encodeURIComponent(jobZipCodes[i]);

                }
            }


            if (filters) {
                //todo common check
                var i;

                if (filters.location) {
                    for (i = 0; i < filters.location.length; i++) {
                        if (params != '?') {
                            params += '&';
                        }
                        params += 'facetlocation=' + encodeURIComponent(filters.location[i]);
                    }
                }

                if (filters.department) {
                    for (i = 0; i < filters.department.length; i++) {
                        if (params != '?') {
                            params += '&';
                        }

                        params += 'department=' + encodeURIComponent(filters.department[i]);
                    }
                }

                if (filters.category) {
                    for (i = 0; i < filters.category.length; i++) {
                        if (params != '?') {
                            params += '&';
                        }

                        params += 'category=' + encodeURIComponent(filters.category[i]);
                    }
                }


                if (filters.salary) {
                    if (params != '?') {
                        params += '&';
                    }

                    params += 'salary=' + encodeURIComponent(filters.salary);
                }

                if (filters.remoteworkoptionids) {
                    for (i = 0; i < filters.remoteworkoptionids.length; i++) {
                        if (params != '?') {
                            params += '&';
                        }

                        params += 'remoteworkoptionids=' + encodeURIComponent(filters.remoteworkoptionids[i]);

                    }
                }

                if (filters.classspecificationscodes) {
                    for (i = 0; i < filters.classspecificationscodes.length; i++) {
                        if (params != '?') {
                            params += '&';
                        }

                        params += 'classspecificationscodes=' + encodeURIComponent(filters.classspecificationscodes[i]);

                    }
                }

                if (filters.examType) {
                    for (i = 0; i < filters.examType.length; i++) {
                        if (params != '?') {
                            params += '&';
                        }

                        params += 'examType=' + encodeURIComponent(filters.examType[i]);

                    }
                }
                if (filters.jobType) {
                    for (i = 0; i < filters.jobType.length; i++) {
                        if (params != '?') {
                            params += '&';
                        }

                        params += 'jobType=' + encodeURIComponent(filters.jobType[i]);

                    }
                }

                if (!$.isEmptyObject(filters)) //Log Google Analytics only if Filters applied
                    filterAction.push('Jobs Filtered');
            }

            if (isPromotionalJobs()) {
                if (params != '?') {
                    params += '&';
                }

                params += 'ispromotional=true';

            }

            if (isTransferJobs()) {
                if (params != '?') {
                    params += '&';
                }

                params += 'istransfer=true';

            }
        }

        if (filterAction.length > 0)//Track Career job searches in Google Analytics
            gJobs.common.analytics.trackCareerJobSearchEvent(filterAction.join(' & '));

        var searchUrl = (params)
            ? SEARCH_AGENCY_JOBS_URL + params
            : SEARCH_AGENCY_JOBS_URL;

        return gJobs.ajax
            .ajaxGet(searchUrl)
            .then(function (response, status, xhr) {

                if (status != "success") {
                    jobsContainer.html('<h1>Cannot load jobs.</h1>');
                } else {
                    jobsContainer.html(response);

                    if (AgencyPages.canvassFlyout.isOpen()) {
                        var focusableSelector = gJobs.ariaSelectors.getFocusableSelector();
                        OnlineApp.Services.tabIndexService.disableTabIndex(
                            {
                                containerSelector: jobListContainerSelector,
                                tabIndexElementsSelector: focusableSelector,
                            }
                        );
                    }

                    clampJobDescriptions();
                }



                checkIfNotFoundAndAdjust(jobtitle);

                addHandlers(jobsContainer);
                adjustCategoriesList();
                if (loadMap != false) {
                    updateNumberFound();
                    notifyShowedItemsCount();
                }

                gJobs.common.social.init();

                initPopovers(jobsContainer);
                if (isMapsOptionSelected())
                    listGridViewService.showList(false, true);
                else
                    listGridViewService.updateView(true);
                $(document).trigger(Events.CommonEventsNames.JobsListLoaded, $('#job-postings-number').text() || 0);

                if (filterflyout.isOpen()) {
                    OnlineApp.Services.tabIndexService.disableTabIndex();
                }

                // Remove redundant title attribute added by addthis JS
                var shareClasses = ['facebook', 'twitter', 'linkedin', 'google_plusone_share', 'email'];
                shareClasses.forEach(function (elClass) {
                    $('.addthis_button_' + elClass).removeAttr('title');
                });

                var pageSettings = userSettingsService.getSettings();

                if (isMapsOptionSelected()) {
                    $('.close-map-location').css('display', 'none');
                    $('.location-desktop').css('display', 'block');
                    $('#jobsdiv').animate({ scrollTop: SCROLL_TOP }, "fast");
                    $('#mapsDiv').css("display", "block");
                    $('#jobsdiv').css("width", "50%");
                    $('#jobsdiv').css("overflow-y", "auto");
                    $('.maplibregl-canvas').attr('tabindex', '-1'); 
                    if (!isMapMobile) {
                        $('html, body').animate({ scrollTop: SCROLL_TOP }, "fast");
                        $('#title-bar').hide();
                        $('.job-search-header-container').hide();
                        $('body').css('overflow-y', 'hidden');
                        $('#manage-bar').css('margin-top', '70px');
                        $('footer').hide();

                        var zoomLevel = window.devicePixelRatio * 100;                        
                        if (zoomLevel >= 300) {                            
                            $('#jobsdiv').css("height", "auto");                          
                            $('body').css('overflow-y', 'auto');
                            $('#manage-bar').css('margin-top', '0px');                          
                        } else {
                            $('#jobsdiv').css("height", "85vh");     
                            $('#mapsDiv').css("height", "85vh");
                            $('.maplibregl-canvas').css("height", "85vh");
                        }  
                    }
                    $('.action-grid-view-container').hide();
                    $('.action-list-view-container').hide();
                    $("#closeMap").removeClass("hidden");
                    $("#openMap").addClass("hidden");
                    if (isMapMobile) {
                        $('#menu-container').css("z-index", 5);
                        $(".maps-open-button").addClass("hidden");
                        $(".jobs-open-button").removeClass("hidden");
                        $("#closeMap").addClass("hidden");
                        $("#openMap").addClass("hidden");
                        $('.maplibregl-canvas').css("height", "85vH");
                        $('#mapsDiv').css("height", "85vH");

                    }

                    $(".vertical-line").hide();
                    $('#number-found-items').css("right", "300px");
                    sessionStorage.setItem("MapsSelected", true);
                    $('#jobsdiv').css("margin-right", "10px");
                    $('#jobsdiv').css("margin-left", "10px");
                    $('.search-results-container').css('margin-top', '0px');
                    $('.listing-title').css('padding-top', '0px');
                    $('.job-listing-container').css("margin-right", "10px");
                    $('.items-div').css("margin-right", "10px");
                    if (loadMap == true) {
                        showOverlay();
                        coordinates = '';

                        ClearFeatures();
                        loadMaps(jobsContainer, keywords, null, sort, filters);
                    }
                    else {
                        hideOverlay();
                        if (clusterId != "") {
                            $('#' + clusterId).focus();
                        }
                        clusterId = "";
                    }
                }
                else {
                    if (globalMap != null) {
                        globalMap.remove();
                        globalMap = null
                    }
                    $('.close-map-location').css('display', 'block');
                    $('.location-desktop').css('display', 'none');
                    $('#menu-container').css("z-index", 2);
                    $('#mapsDiv').css("display", "none");
                    $('#jobsdiv').css("display", "block");
                    $('#jobsdiv').css("width", "100%");
                    $('#jobsdiv').css("overflow-y", "hidden");
                    $('#jobsdiv').css("height", "100%");
                    $('#jobsdiv').css("margin-right", "0px");
                    $('#jobsdiv').css("margin-left", "0px");
                    $('.action-grid-view-container').show();
                    $('.action-list-view-container').show();
                    $("#closeMap").addClass("hidden");
                    $("#openMap").removeClass("hidden");
                    if (isMapMobile) {
                        $(".maps-open-button").removeClass("hidden");
                        $(".jobs-open-button").addClass("hidden");
                        $("#closeMap").addClass("hidden");
                        $("#openMap").addClass("hidden");
                    }
                    $(".vertical-line").show();
                    $('#number-found-items').css("right", "310px");
                    sessionStorage.setItem("MapsSelected", false);
                    $('.search-results-container').css('margin-top', '18px');
                    $('.listing-title').css('padding-top', '10px');
                    $('.job-listing-container').css("margin-right", "0px");
                    $('.items-div').css("margin-right", "0px");
                    hideOverlay();
                }
            });
    }

    function isMapsOptionSelected() {
        var mapsSeelected = isMapMobile ? $('.maps-open-button').hasClass("hidden") : $('#openMap').hasClass("hidden");
        var settingsString = sessionStorage.getItem("MapsSelected") == "true" ? true : false;
        return mapsSeelected && settingsString;
    }

    function loadMaps(jobsContainer, jobtitle, page, sort, filters) {

        if (globalMap != null) {
            globalMap.remove();
            globalMap = null;
        }
        $("#mapsDiv").empty();
        showOverlay();

        currentParams = {
            jobtitle: jobtitle,
            page: parseInt(page),
            sort: sort,
            filters: filters
        };

        var params = undefined;
        let filterAction = [];

        var agencyFolderName = pageInfoService.getCurrentAgencyFolderName();

        var departmentFolderName = pageInfoService.getCurrentDepartmentFolderName();

        if (agencyFolderName || jobtitle || page || sort || filters || isPromotionalJobs() || isTransferJobs()) {
            params = '?';
            if (agencyFolderName) {
                if (params != '?') {
                    params += '&';
                }
                params += 'agency=' + encodeURIComponent(agencyFolderName);
            }

            if (departmentFolderName) {
                if (params != '?') {
                    params += '&';
                }
                params += 'departmentFolder=' + encodeURIComponent(departmentFolderName);
            }

            if (jobtitle) {
                if (params != '?') {
                    params += '&';
                }
                params += 'keyword=' + encodeURIComponent(jobtitle);
                filterAction.push('Jobs Searched');
            }


            if (filters) {
                var i;
                if (filters.location) {
                    for (i = 0; i < filters.location.length; i++) {
                        if (params != '?') {
                            params += '&';
                        }
                        params += 'facetlocation=' + encodeURIComponent(filters.location[i]);
                    }
                }

                if (filters.department) {
                    for (i = 0; i < filters.department.length; i++) {
                        if (params != '?') {
                            params += '&';
                        }
                        params += 'department=' + encodeURIComponent(filters.department[i]);
                    }
                }

                if (filters.category) {
                    for (i = 0; i < filters.category.length; i++) {
                        if (params != '?') {
                            params += '&';
                        }
                        params += 'category=' + encodeURIComponent(filters.category[i]);
                    }
                }


                if (filters.salary) {
                    if (params != '?') {
                        params += '&';
                    }
                    params += 'salary=' + encodeURIComponent(filters.salary);
                }

                if (filters.remoteworkoptionids) {
                    for (i = 0; i < filters.remoteworkoptionids.length; i++) {
                        if (params != '?') {
                            params += '&';
                        }
                        params += 'remoteworkoptionids=' + encodeURIComponent(filters.remoteworkoptionids[i]);
                    }
                }

                if (filters.classspecificationscodes) {
                    for (i = 0; i < filters.classspecificationscodes.length; i++) {
                        if (params != '?') {
                            params += '&';
                        }
                        params += 'classspecificationscodes=' + encodeURIComponent(filters.classspecificationscodes[i]);
                    }
                }

                if (filters.examType) {
                    for (i = 0; i < filters.examType.length; i++) {
                        if (params != '?') {
                            params += '&';
                        }
                        params += 'examType=' + encodeURIComponent(filters.examType[i]);
                    }
                }
                if (filters.jobType) {
                    for (i = 0; i < filters.jobType.length; i++) {
                        if (params != '?') {
                            params += '&';
                        }
                        params += 'jobType=' + encodeURIComponent(filters.jobType[i]);
                    }
                }

                if (!$.isEmptyObject(filters)) //Log Google Analytics only if Filters applied
                    filterAction.push('Jobs Filtered');
            }

            if (isPromotionalJobs()) {
                if (params != '?') {
                    params += '&';
                }
                params += 'ispromotional=true';
            }

            if (isTransferJobs()) {
                if (params != '?') {
                    params += '&';
                }

                params += 'istransfer=true';
            }
        }

        var searchUrl = (params)
            ? AgencyPages.routePrefix + "/home/loadJobsOnMaps" + params
            : AgencyPages.routePrefix + "/home/loadJobsOnMaps";

        gJobs.ajax
            .ajaxGet(searchUrl)
            .then(function (response, status, xhr) {
                if (response.success == true && response.isMapSearchEnable == true) {
                    mapJobsCount = response.jobList.length;
                    if (isMapMobile) {
                        checkIfNotFoundAndAdjustForMapsMobile(jobtitle);
                    }
                    mapJobsCount = 0;
                    if (isMapMobile) {
                        if (isMapsOptionSelected()) {
                            $('#jobsdiv').css("display", "none");
                            $('#mapsDiv').css("width", "100%");
                        }
                        else {
                            $('#mapsDiv').css("display", "none");
                            $('#jobsdiv').css("width", "100%");
                        }
                    }
                    else {
                        $('#jobsdiv').css("width", "50%");
                        $('#jobsdiv').css("height", "85vH");
                        $('#jobsdiv').css("overflow-y", "auto");
                        $('#flexDiv').css("display", "flex");
                    }
                    $('.action-grid-view-container').hide();
                    $('#number-found-items').css("right", "300px");
                    $('.action-list-view-container').hide();

                    const key = response.mapTilerKey;
                    var ll = new maplibregl.LngLat(response.employerLongitudeValue, response.employerLattitudeValue);
                    var bounds = ll.toBounds(response.mapBoundsValue).toArray();
                    //Initialize maps options
                    var options = {
                        container: 'mapsDiv',
                        style:
                            'https://api.maptiler.com/maps/streets/style.json?key=' + key,
                        center: [response.employerLongitudeValue, response.employerLattitudeValue],
                        maxZoom: response.mapsMaxZoom,
                        maxBounds: bounds
                    };
                    var map = new maplibregl.Map(options);
                    options.minZoom = map.getZoom();
                    $("#mapsDiv").empty();
                    map = new maplibregl.Map(options);
                    //setting global map object to use it outside loadMaps method scope if needed
                    globalMap = map;
                    if (isMapMobile == false) {
                        map.addControl(new maplibregl.NavigationControl());
                        $('.maplibregl-ctrl-bottom-right').hide();
                    }
                    if (response.jobList.length > 0 && response.isMapSearchEnable) {
                        map.on('load', function () {
                            $(".maplibregl-control-container").remove().insertBefore($(".maplibregl-canvas-container"));

                            const canvas = map.getCanvasContainer();
                            //generating geojson dynamically
                            var gj = {
                                'type': 'geojson',
                                'data': {
                                    'type': 'FeatureCollection',
                                    'features': []
                                },
                                'cluster': true,
                                'clusterMaxZoom': 14, // Max zoom to cluster points on
                                'clusterRadius': 50 // Radius of each cluster when clustering points (defaults to 50)
                            };
                            for (var i = 0; i < response.jobList.length; i++) {
                                gj.data.features.push(
                                    {
                                        'type': 'Feature',
                                        'properties': {
                                            'jobid': response.jobList[i].ID,
                                            'mapClusterId': response.jobList[i].ClusterIdForMap,
                                            'jobtitle': response.jobList[i].JobTitle,
                                            'classification': response.jobList[i].Classification,
                                            'latitude': response.jobList[i].Lattitude,
                                            'longitude': response.jobList[i].Longitude,
                                            'jobzipcode': response.jobList[i].JobZipCode,
                                            'location': response.islocationvisible && response.jobList[i].Location != null && response.jobList[i].Location != '' && response.jobList[i].Location != undefined ? response.jobList[i].Location : '',
                                            'jobtype': response.istypevisible && response.jobList[i].JobType != null && response.jobList[i].JobType != undefined && response.jobList[i].JobType != '' ? response.jobList[i].JobType : '',
                                            'salaryinfo': response.issalaryvisible && response.jobList[i].SalaryInfo != null && response.jobList[i].SalaryInfo != '' && response.jobList[i].SalaryInfo != undefined ? response.jobList[i].SalaryInfo : '',
                                            'category': response.iscategoryvisible && response.jobList[i].Categories != null ? response.jobList[i].Categories.join('/') : "",
                                            'departmentcustomlabel': response.isdepartmentvisible && response.customLabels.Department.SingularLabel,
                                            'department': response.isdepartmentvisible && response.jobList[i].DepartmentName != null && response.jobList[i].DepartmentName != undefined && response.jobList[i].DepartmentName != '' ? response.jobList[i].DepartmentName : '',
                                            'examtype': response.isexamtypevisible && response.jobList[i].ExamType != null && response.jobList[i].ExamType != '' && response.jobList[i].ExamType != undefined ? response.jobList[i].ExamType : '',
                                            'divisioncustomlabel': response.isdivisionvisible && response.customLabels.Division.SingularLabel,
                                            'division': response.isdivisionvisible && response.jobList[i].Division != null && response.jobList[i].Division != undefined && response.jobList[i].Division != '' ? response.jobList[i].Division : '',
                                            'remoteworkoption': response.isremotevisible && response.isRemoteOptionEnabled && response.jobList[i].RemoteWorkOptionText != null && response.jobList[i].RemoteWorkOptionText != undefined && response.jobList[i].RemoteWorkOptionText != '' ? response.jobList[i].RemoteWorkOptionText : '',
                                            'issalaryvisible': response.jobList[i].IsSalaryVisible && response.issalaryvisible,
                                            'opendate': response.isopendatevisible && response.jobList[i].OpenDate != '' ? response.jobList[i].OpenDate : '',
                                            'showclosingdate': response.jobList[i].ShowClosingDateTime,
                                            'closedate': response.isclosingdatevisible && response.jobList[i].CloseDate != '' ? response.jobList[i].CloseDate : '',
                                            'isnew': response.jobList[i].IsNew

                                        },

                                        'geometry': {
                                            'type': 'Point',

                                            'coordinates': [
                                                response.jobList[i].Longitude, response.jobList[i].Lattitude
                                            ]
                                        }
                                    }
                                );
                            }

                            var geoJson = JSON.stringify(gj).trim("'");

                            //Generated geojson dynamically and adding that to map
                            map.addSource('jobs',
                                JSON.parse(geoJson)

                            );

                            //adding custom images to map
                            map.loadImage(
                                '/Content/Images/AgencyPages/Maps/bluepin.png',
                                (error, image) => {
                                    if (error) throw error;
                                    // Add the image to the map style.
                                    map.addImage('unclusterdImage', image);
                                    map.addLayer({
                                        id: 'unclustered-point',
                                        type: 'symbol',
                                        source: 'jobs',
                                        filter: ['!', ['has', 'point_count']],
                                    });
                                });

                            var markers = {};
                            var markersOnScreen = {};

                            //Code to load marker on screen
                            function updateMarkers() {
                                var newMarkers = {};
                                var features = map.querySourceFeatures('jobs');

                                // for every cluster on the screen, create an HTML marker for it (if we didn't yet),
                                // and add it to the map if it's not there already
                                for (var i = 0; i < features.length; i++) {
                                    var coords = features[i].geometry.coordinates;
                                    var props = features[i].properties;
                                    var id = ""
                                    if (!props.cluster) id = props.mapClusterId;
                                    else id = props.cluster_id;
                                    var marker = markers[id];
                                    if (!marker) {
                                        var el = createDonutChart(props);
                                        if (!props.cluster) {
                                            if (!isMapMobile) {
                                                var popup = new maplibregl.Popup({ id: id });
                                                popup.on('close', function (e) {
                                                    if (isOpenPopup) {
                                                        gJobs.screenReadersService.setAriaLiveNotification("Popup closed");
                                                    }
                                                    $('#' + e.target.options.id).focus();
                                                })
                                                popup.on('open', function (e) {
                                                    // popup opened so we fire an event
                                                    isOpenPopup = true;
                                                });
                                                var popupContent =
                                                    '<div class="map-container">'
                                                    ;
                                                popupContent +=
                                                    '<li data-job-id=' + props.jobid + ' data-classification="' + props.classification + '" class="map-td"><a class="marker-link" aria-label="' + props.classification + '" tabindex="0" data-job-id=' + props.jobid + ' data-job-title=' + props.jobtitle + ' data-classification="' + props.classification + '">' + props.classification + '</a></li> ';

                                                popup.setLngLat(features[i].geometry.coordinates)
                                                    .setHTML(
                                                        popupContent
                                                ).on('open', function (e) {
                                                    $(".maplibregl-popup-close-button").remove().insertBefore($(".map-container"));
                                                    $('.maplibregl-popup-content').css('overflow-y', 'hidden');
                                                    $('.map-td').css('border-bottom', 'none');
                                                    $('.maplibregl-popup-close-button').attr('tabindex', 0);

                                                    gJobs.screenReadersService.setAriaLiveNotification("Popup opened with job titles");
                                                    $('.container a.marker-link').click(function (e) {
                                                        isLinkOpenFromDesktopMapPopUp = true;
                                                        var pageType = pageInfoService.getCurrentPageType().type;
                                                        var newQuery = location.search ?
                                                            location.search + '&pagetype=' + pageType :
                                                            '?pagetype=' + pageType;

                                                        namespace('AgencyPages').router.navigate("/careers/" + agencyFolderName + "/jobs/" + e.target.dataset.jobId + "/" + e.target.dataset.jobTitle + newQuery, true, false, null, {
                                                            id: e.target.dataset.jobId,
                                                            title: e.target.dataset.classification,
                                                            tab: 1
                                                        });
                                                    });
                                                    $('.container a.marker-link').keydown(function (e) {
                                                        if (e.key === 'Enter' || e.keyCode === 13) {
                                                            isLinkOpenFromDesktopMapPopUp = true;
                                                            var pageType = pageInfoService.getCurrentPageType().type;
                                                            var newQuery = location.search ?
                                                                location.search + '&pagetype=' + pageType :
                                                                '?pagetype=' + pageType;

                                                            namespace('AgencyPages').router.navigate("/careers/" + agencyFolderName + "/jobs/" + e.target.dataset.jobId + "/" + e.target.dataset.jobTitle + newQuery, true, false, null, {
                                                                id: e.target.dataset.jobId,
                                                                title: e.target.dataset.classification,
                                                                tab: 1
                                                            });
                                                        }
                                                        if (e.keyCode === 27) {

                                                            $('.maplibregl-popup-close-button').click();
                                                        }
                                                    });
                                                    $('.container li:last-child a.marker-link').keydown(function (e) {
                                                        if (e.keyCode === $.ui.keyCode.TAB && !e.shiftKey) {
                                                            e.preventDefault();
                                                            $('.maplibregl-popup-close-button').attr('tabindex', 0).focus();
                                                        }
                                                    });
                                                    $('.maplibregl-popup-close-button').keydown(function (e) {
                                                        if (e.key === 'Enter' || e.keyCode === 13 || e.keyCode === $.ui.keyCode.ESCAPE) {
                                                            setTimeout(function () {
                                                                $('.maplibregl-popup-close-button').click();
                                                            },200);
                                                        }
                                                        else if (e.keyCode === $.ui.keyCode.TAB && e.shiftKey) {
                                                            e.preventDefault();
                                                            $('.container li:last-child a.marker-link').attr('tabindex', 0).focus();
                                                        }
                                                    }); 
                                                        $('.maplibregl-popup-close-button').focus();
                                                    })
                                                marker = markers[id] = new maplibregl.Marker({
                                                    element: el
                                                }).setLngLat(coords).setPopup(popup);
                                            }
                                            else {
                                                el.addEventListener('click', (e) => {
                                                    openMobileCardForSingleMarker(e);
                                                });
                                                marker = markers[id] = new maplibregl.Marker({
                                                    element: el
                                                }).setLngLat(coords);
                                            }

                                        }
                                        else {
                                            el.addEventListener('keydown', (e) => {
                                                openPopupkeydown(e);
                                            }
                                            );
                                            el.addEventListener('click', (e) => {
                                                openPopupClick(e);
                                            }
                                            );
                                            marker = markers[id] = new maplibregl.Marker({
                                                element: el
                                            }).setLngLat(coords);
                                        }
                                    }
                                    newMarkers[id] = marker;

                                    if (!markersOnScreen[id]) marker.addTo(map);
                                }
                                // for every marker we've added previously, remove those that are no longer visible
                                for (id in markersOnScreen) {
                                    if (!newMarkers[id]) markersOnScreen[id].remove();
                                }
                                markersOnScreen = newMarkers;
                            }

                            // after the GeoJSON data is loaded, update markers on the screen and do so on every map move/moveend
                            map.on('data', function (e) {
                                if (e.sourceId !== 'jobs' || !e.isSourceLoaded) return;
                                map.on('move', updateMarkers);
                                map.on('moveend', updateMarkers);
                                updateMarkers();
                            });

                            //Moveend event will take care of zoom and drag functionality combined. In this event
                            //we are checking markers highlight whenever it is dragged or zoomed
                            map.on('moveend', function (e) {

                                var newPage = "1";
                                var currentQueryParams = url.get(window.location.search.slice(1), { array: true });
                                currentQueryParams.page = newPage;
                                var newQuery = '?' + url.buildget(currentQueryParams);

                                AgencyPages.router.navigate(initialUrl + newQuery, true, null, null, currentQueryParams);


                                ClearFeatures();
                                updateMarkers();
                                var featuresToUpdate = map.querySourceFeatures('jobs');
                                for (var j = 0; j < mapHighlightLatLong.length; j++) {
                                    var latlongString = mapHighlightLatLong[j];
                                    var latLongValue = latlongString.split(',');
                                    var lat = latLongValue[0];
                                    var lng = latLongValue[1];
                                    coordinates = new maplibregl.LngLat(lng, lat);
                                    var isInsideBound = map.getBounds().contains(coordinates)
                                    if (isInsideBound) {
                                        if (coordinates != undefined && coordinates != '') {
                                            let arrayFeatures = [];
                                            for (var i = 0; i < featuresToUpdate.length; i++) {

                                                var coords = featuresToUpdate[i].geometry.coordinates;
                                                var props = featuresToUpdate[i].properties;
                                                var FeatureLatLong = new maplibregl.LngLat(coords[0], coords[1]);
                                                var distance = coordinates.distanceTo(FeatureLatLong);
                                                arrayFeatures.push({
                                                    distance: distance,
                                                    feature: featuresToUpdate[i],

                                                });

                                            }
                                            var smallest = arrayFeatures.sort((a, b) => a.distance - b.distance);

                                            if (smallest[0].feature.properties.cluster_id != undefined) {
                                                if (co_ords.length > 0) {
                                                    var image = document.getElementById(smallest[0].feature.properties.cluster_id.toString());
                                                    image.innerHTML = image.innerHTML.replace("bluepin-number", "redpin")
                                                }
                                                $('#' + smallest[0].feature.properties.cluster_id).focus();
                                                clusterId = smallest[0].feature.properties.cluster_id;
                                            }
                                            else {
                                                if (smallest[0].feature.properties.jobid == mapHighlightJobId) {
                                                    if (co_ords.length > 0) {
                                                        var image = document.getElementById(smallest[0].feature.properties.mapClusterId.toString());
                                                        image.innerHTML = image.innerHTML.replace("bluepin", "redpin2")
                                                    }
                                                    $('#' + smallest[0].feature.properties.mapClusterId).focus();
                                                    clusterId = smallest[0].feature.properties.mapClusterId;
                                                }

                                            }

                                        }
                                    }
                                }
                            });

                            //Function to open popup for clustered and non-clustered markers
                            function openPopup(clusterId, pointCount) {
                                isOpenPopup = true;
                                var clusterSource = map.getSource('jobs');
                                //Code to read cluster leaves
                                clusterSource.getClusterLeaves(clusterId, pointCount, 0, function (error, features) {
                                    var zoom = map.getZoom();
                                    if (co_ords.length == 0) {
                                        coordinates = new maplibregl.LngLat(features[0].geometry.coordinates[0], features[0].geometry.coordinates[1]);
                                    }
                                    else {
                                        for (var i = 0; i < co_ords.length; i++) {
                                            var latlongString = co_ords[i];
                                            var latLongValue = latlongString.split(',');
                                            var lat = latLongValue[0];
                                            var lng = latLongValue[1];
                                            for (var j = 0; j < features.length; j++) {
                                                if (features[j].geometry.coordinates[0] == lng && features[j].geometry.coordinates[1] == lat) {
                                                    coordinates = new maplibregl.LngLat(features[j].geometry.coordinates[0], features[j].geometry.coordinates[1]);
                                                }
                                            }
                                        }
                                    }
                                    if (zoom < 10 && features.length > 5) {
                                        map.flyTo({
                                            center: features[0].geometry.coordinates, zoom: zoom + 1, essential: true
                                        });
                                    }
                                    else {
                                        var popup = new maplibregl.Popup();

                                        var popupContent =
                                            '<div class="map-container">'
                                            ;

                                        let sortedFeatures = features.sort((p1, p2) => (p1.properties.classification.toUpperCase() > p2.properties.classification.toUpperCase()) ? 1 : (p1.properties.classification.toUpperCase() < p2.properties.classification.toUpperCase()) ? -1 : 0);

                                        sortedFeatures.forEach(function (marker) {
                                            popupContent +=
                                                '<li data-job-id=' + marker.properties.jobid + ' class="map-td"><a tabindex="0" aria-label="' + marker.properties.classification + '" class="marker-link" data-job-id=' + marker.properties.jobid + ' data-job-title=' + marker.properties.jobtitle + ' data-classification="' + marker.properties.classification + '">' + marker.properties.classification + '</a></li> ';
                                        });

                                        popup = new maplibregl.Popup();
                                        popup.on('close', function (e) {
                                            if (isOpenPopup) {
                                                gJobs.screenReadersService.setAriaLiveNotification("Popup closed");
                                            }
                                            $('#' + clusterId).focus();
                                        })
                                        popup.setLngLat(features[0].geometry.coordinates)
                                            .setHTML(
                                                popupContent
                                            ).on('open', function () {
                                                $(".maplibregl-popup-close-button").remove().insertBefore($(".map-container"));
                                                $('.maplibregl-popup-content').css('overflow-y', 'auto');
                                                $('.map-td').css('border-bottom', '1px solid #dddddd');
                                                $('.maplibregl-popup-close-button').attr('tabindex', 0);
                                                gJobs.screenReadersService.setAriaLiveNotification("Popup opened with job titles");
                                                $('.container a.marker-link').click(function (e) {
                                                    isLinkOpenFromDesktopMapPopUp = true;
                                                    var pageType = pageInfoService.getCurrentPageType().type;
                                                    var newQuery = location.search ?
                                                        location.search + '&pagetype=' + pageType :
                                                        '?pagetype=' + pageType;

                                                    namespace('AgencyPages').router.navigate("/careers/" + agencyFolderName + "/jobs/" + e.target.dataset.jobId + "/" + e.target.dataset.jobTitle + newQuery, true, false, null, {
                                                        id: e.target.dataset.jobId,
                                                        title: e.target.dataset.classification,
                                                        tab: 1
                                                    });
                                                });
                                                $('.container a.marker-link').keydown(function (e) {
                                                    if (e.key === 'Enter' || e.keyCode === 13) {
                                                        isLinkOpenFromDesktopMapPopUp = true;
                                                        var pageType = pageInfoService.getCurrentPageType().type;
                                                        var newQuery = location.search ?
                                                            location.search + '&pagetype=' + pageType :
                                                            '?pagetype=' + pageType;

                                                        namespace('AgencyPages').router.navigate("/careers/" + agencyFolderName + "/jobs/" + e.target.dataset.jobId + "/" + e.target.dataset.jobTitle + newQuery, true, false, null, {
                                                            id: e.target.dataset.jobId,
                                                            title: e.target.dataset.classification,
                                                            tab: 1
                                                        });
                                                    }
                                                    if (e.keyCode === 27) {
                                                        $('.maplibregl-popup-close-button').click();
                                                    }
                                                });
                                                $('.container li:last-child a.marker-link').keydown(function (e) {
                                                    if (e.keyCode === $.ui.keyCode.TAB && !e.shiftKey) {
                                                        e.preventDefault();
                                                        $('.maplibregl-popup-close-button').attr('tabindex', 0).focus();
                                                    }
                                                });
                                                $('.maplibregl-popup-close-button').keydown(function (e) {                                                   
                                                    if (e.key === 'Enter' || e.keyCode === 13 || e.keyCode === $.ui.keyCode.ESCAPE) {
                                                        $('.maplibregl-popup-close-button').click();
                                                    }
                                                    else if (e.keyCode === $.ui.keyCode.TAB && e.shiftKey) {
                                                        e.preventDefault();
                                                        $('.container li:last-child a.marker-link').attr('tabindex', 0).focus();
                                                    }
                                                }); 
                                                $('.maplibregl-popup-close-button').focus();
                                            })
                                            .addTo(map);
                                    }

                                });
                            }

                            //This function is for mobile devices to open  cards
                            function openMobileCards(clusterId, pointCount) {

                                var clusterSource = map.getSource('jobs');

                                clusterSource.getClusterLeaves(clusterId, pointCount, 0, function (error, features) {
                                    // Print cluster leaves in the console
                                    var zoom = map.getZoom();
                                    clearAllCards();
                                    for (var i = 0; i < co_ords.length; i++) {
                                        var latlongString = co_ords[i];
                                        var latLongValue = latlongString.split(',');
                                        var lat = latLongValue[0];
                                        var lng = latLongValue[1];
                                        for (var j = 0; j < features.length; j++) {
                                            if (features[j].geometry.coordinates[0] == lng && features[j].geometry.coordinates[1] == lat) {
                                                coordinates = new maplibregl.LngLat(features[j].geometry.coordinates[0], features[j].geometry.coordinates[1]);
                                            }
                                        }
                                    }

                                    if (zoom < 10 && features.length > 5) {
                                        map.flyTo({
                                            center: features[0].geometry.coordinates, zoom: zoom + 1, essential: true
                                        });
                                    }
                                    else {
                                        let sortedFeatures = features.sort((p1, p2) => (p1.properties.classification.toUpperCase() > p2.properties.classification.toUpperCase()) ? 1 : (p1.properties.classification.toUpperCase() < p2.properties.classification.toUpperCase()) ? -1 : 0);
                                        for (var i = 0; i < sortedFeatures.length; i++) {

                                            jobZipCodes.push(sortedFeatures[i].properties.jobzipcode);

                                        }
                                        //get unique zip codes
                                        jobZipCodes.sort(function (a, b) { return a - b });

                                        jobZipCodes = jobZipCodes.filter((item, i, ar) => ar.indexOf(item) === i);
                                        loadJobs(jobsContainer, keywords, null, sort, filters, false);
                                        if (sortedFeatures.length <= 2) {
                                            $("#map-card-container").css("position", "fixed");
                                            $("#map-card-container").css("height", "auto");
                                            sortedFeatures.forEach(function (marker) {

                                                var html = '';
                                                html +=

                                                    "<div id='map-card-display' data-job-id=" + marker.properties.jobid + " class='map-td'>";
                                                if (marker.properties.isnew == true) {
                                                    html += '<li><a tabindex="0" aria-label="' + marker.properties.classification + '" class="marker-link" data-classification="' + marker.properties.classification + '"  data-job-id="' + marker.properties.jobid + '" data-job-title="' + marker.properties.jobtitle + '">' + marker.properties.classification +
                                                        "</a><span class='label label-success new-job-label'>New</span></li>";
                                                }
                                                else {
                                                    html += '<li><a tabindex="0" aria-label="' + marker.properties.classification + '" class="marker-link" data-classification="' + marker.properties.classification + '"  data-job-id="' + marker.properties.jobid + '" data-job-title="' + marker.properties.jobtitle + '">' + marker.properties.classification +
                                                        "</a></li>";
                                                }
                                                html += "<ul class='list-meta'>";
                                                if (marker.properties.location != '') {
                                                    html += "<li class='location'>" + marker.properties.location + "</li>";
                                                }
                                                if (marker.properties.jobtype != '') {
                                                    if (marker.properties.issalaryvisible == true) {
                                                        html += "<li>" + marker.properties.jobtype;
                                                    }
                                                    else {
                                                        html += "<li>" + marker.properties.jobtype + "</li>";
                                                    }
                                                }
                                                if (marker.properties.issalaryvisible == true) {
                                                    html += "<span> | </span>";
                                                    html += marker.properties.salaryinfo + "</li>";
                                                }
                                                if (marker.properties.category != '') {
                                                    html += "<li class='categories-list'>Category : " + marker.properties.category + "</li>";
                                                }
                                                if (marker.properties.department != '') {
                                                    html += "<li>" + marker.properties.departmentcustomlabel + " : " + marker.properties.department + "</li>";
                                                }
                                                if (marker.properties.examtype != '') {
                                                    html += "<li>Exam Type : " + marker.properties.examtype + "</li>";
                                                }
                                                if (marker.properties.division != '') {
                                                    html += "<li>" + marker.properties.divisioncustomlabel + " : " + marker.properties.division + "</li>";
                                                }
                                                if (marker.properties.remoteworkoption != '') {
                                                    html += "<li>Remote : " + marker.properties.remoteworkoption + "</li>";
                                                }
                                                html += "</ul>"
                                                html += "<div class='list-published'>"
                                                if (marker.properties.opendate != '') {
                                                    html += "<span class='list-entry-starts'><span>" + marker.properties.opendate + "</span></span>"
                                                }
                                                if (marker.properties.showclosingdate == true && marker.properties.closedate != '') {
                                                    html += "<span class='divider'> | </span>";
                                                    html += "<span class='list-entry-ends'>" + marker.properties.closedate + "</span>";
                                                }
                                                html += "</div></div > ";
                                                document.getElementById("map-card-container").innerHTML += html;
                                            });
                                        }
                                        else {
                                            $("#map-card-container").css("position", "absolute");
                                            $("#map-card-container").css("height", "85vH");
                                            $("#map-card-container").css("background", "white");
                                            $("#map-card-container").css("overflow-y", "scroll");
                                            $("body").css("overflow-y", "hidden");
                                            var html = "<div id='flyout new-job-flyout flyout-window' style='width:100%;background:white;height:1000px;'><div class='navigation-links '><a class='icon icon-xs icon-chevron-left prev-posting popover-trigger disable' id='closeMultiCard' href='#' ></a></div>";
                                            sortedFeatures.forEach(function (marker) {

                                                html +=

                                                    "<div id='map-card-display' data-job-id=" + marker.properties.jobid + " class='map-td'>";
                                                if (marker.properties.isnew == true) {
                                                    html += '<li><a tabindex="0" aria-label="' + marker.properties.classification + '" class="marker-link" data-classification="' + marker.properties.classification + '"  data-job-id="' + marker.properties.jobid + '" data-job-title="' + marker.properties.jobtitle + '">' + marker.properties.classification +
                                                        "</a><span class='label label-success new-job-label'>New</span></li>";
                                                }
                                                else {
                                                    html += '<li><a tabindex="0" aria-label="' + marker.properties.classification + '" class="marker-link" data-classification="' + marker.properties.classification + '"  data-job-id="' + marker.properties.jobid + '" data-job-title="' + marker.properties.jobtitle + '">' + marker.properties.classification +
                                                        "</a></li>";
                                                }
                                                html += "<ul class='list-meta'>";
                                                if (marker.properties.location != '') {
                                                    html += "<li class='location'>" + marker.properties.location + "</li>";
                                                }
                                                if (marker.properties.jobtype != '') {
                                                    if (marker.properties.issalaryvisible == true) {
                                                        html += "<li>" + marker.properties.jobtype;
                                                    }
                                                    else {
                                                        html += "<li>" + marker.properties.jobtype + "</li>";
                                                    }
                                                }
                                                if (marker.properties.issalaryvisible == true) {
                                                    html += "<span> | </span>";
                                                    html += marker.properties.salaryinfo + "</li>";
                                                }
                                                if (marker.properties.category != '') {
                                                    html += "<li class='categories-list'>Category : " + marker.properties.category + "</li>";
                                                }
                                                if (marker.properties.department != '') {
                                                    html += "<li>" + marker.properties.departmentcustomlabel + " : " + marker.properties.department + "</li>";
                                                }
                                                if (marker.properties.examtype != '') {
                                                    html += "<li>Exam Type : " + marker.properties.examtype + "</li>";
                                                }
                                                if (marker.properties.division != '') {
                                                    html += "<li>" + marker.properties.divisioncustomlabel + " : " + marker.properties.division + "</li>";
                                                }
                                                if (marker.properties.remoteworkoption != '') {
                                                    html += "<li>Remote : " + marker.properties.remoteworkoption + "</li>";
                                                }
                                                html += "</ul>"
                                                html += "<div class='list-published'>"
                                                if (marker.properties.opendate != '') {
                                                    html += "<span class='list-entry-starts'><span>" + marker.properties.opendate + "</span></span>"
                                                }
                                                if (marker.properties.showclosingdate == true && marker.properties.closedate != '') {
                                                    html += "<span class='divider'> | </span>";
                                                    html += "<span class='list-entry-ends'>" + marker.properties.closedate + "</span>";
                                                }
                                                html += "</div></div>";

                                            });
                                            html += "</div>"
                                            document.getElementById("map-card-container").innerHTML = html;
                                        }
                                        $('#closeMultiCard').click(function (e) {
                                            clearAllCards();
                                            $("#map-card-container").css("background", "transparent");
                                            $("#map-card-container").css("overflow-y", "none");
                                            $("body").css("overflow-y", "auto");
                                        });

                                        $('.container a.marker-link').click(function (e) {
                                            isLinkOpenFromMobileMapPopUp = true;
                                            var pageType = pageInfoService.getCurrentPageType().type;
                                            var newQuery = location.search ?
                                                location.search + '&pagetype=' + pageType :
                                                '?pagetype=' + pageType;

                                            namespace('AgencyPages').router.navigate("/careers/" + agencyFolderName + "/jobs/" + e.target.dataset.jobId + "/" + e.target.dataset.jobTitle + newQuery, true, false, null, {
                                                id: e.target.dataset.jobId,
                                                title: e.currentTarget.dataset.classification,
                                                tab: 1
                                            });
                                        });

                                    }

                                });
                            }

                            function openMobileCardForSingleMarker(e) {
                                isSingleMarkerClicked = true;
                                clearAllCards();
                                $("#map-card-container").css("position", "fixed");
                                $("#map-card-container").css("height", "auto");
                                jobZipCodes.push(e.currentTarget.dataset.jobzipcode);
                                jobZipCodes.sort(function (a, b) { return a - b });

                                jobZipCodes = jobZipCodes.filter((item, i, ar) => ar.indexOf(item) === i);
                                loadJobs(jobsContainer, keywords, null, sort, filters, false);
                                var html = '';
                                html +=
                                    "<div id='map-card-display'>" +
                                    "<div class='map-td'>";
                                if (e.currentTarget.dataset.isnew == 'true') {
                                    html += '<li class="list-item"><a tabindex="0" aria-label="' + e.currentTarget.dataset.classification + '" class="marker-link" data-job-id="' + e.currentTarget.dataset.jobid + '" data-job-title="' + e.currentTarget.dataset.jobtitle + '" data-classification="' + e.currentTarget.dataset.classification + '"">' + e.currentTarget.dataset.classification +
                                        "</a><span class='label label-success new-job-label'>New</span></li>";
                                }
                                else {
                                    html += '<li class="list-item"><a tabindex="0" aria-label="' + e.currentTarget.dataset.classification + '" class="marker-link" data-job-id="' + e.currentTarget.dataset.jobid + '" data-job-title="' + e.currentTarget.dataset.jobtitle + '" data-classification="' + e.currentTarget.dataset.classification + '"">' + e.currentTarget.dataset.classification +
                                        "</a></li>";
                                }
                                html += "<ul class='list-meta'>";
                                if (e.currentTarget.dataset.location != '') {
                                    html += "<li class='location'>" + e.currentTarget.dataset.location + "</li>";
                                }
                                if (e.currentTarget.dataset.jobtype != '') {
                                    if (e.currentTarget.dataset.issalaryvisible == 'true') {
                                        html += "<li>" + e.currentTarget.dataset.jobtype;
                                    }
                                    else {
                                        html += "<li>" + e.currentTarget.dataset.jobtype + "</li>";
                                    }
                                }
                                if (e.currentTarget.dataset.issalaryvisible == 'true') {
                                    html += "<span> | </span>";
                                    html += e.currentTarget.dataset.salaryinfo + "</li>";
                                }
                                if (e.currentTarget.dataset.category != '') {
                                    html += "<li class='categories-list'>Category : " + e.currentTarget.dataset.category + "</li>";
                                }
                                if (e.currentTarget.dataset.department != '') {
                                    html += "<li>" + e.currentTarget.dataset.departmentcustomlabel + " : " + e.currentTarget.dataset.department + "</li>";
                                }
                                if (e.currentTarget.dataset.examtype != '') {
                                    html += "<li>Exam Type : " + e.currentTarget.dataset.examtype + "</li>";
                                }
                                if (e.currentTarget.dataset.division != '') {
                                    html += "<li>" + e.currentTarget.dataset.divisioncustomlabel + " : " + e.currentTarget.dataset.division + "</li>";
                                }
                                if (e.currentTarget.dataset.remoteworkoption != '') {
                                    html += "<li>Remote : " + e.currentTarget.dataset.remoteworkoption + "</li>";
                                }
                                html += "</ul>"
                                html += "<div class='list-published'>"
                                if (e.currentTarget.dataset.opendate != '') {
                                    html += "<span class='list-entry-starts'><span>" + e.currentTarget.dataset.opendate + "</span></span>"
                                }
                                if (e.currentTarget.dataset.showclosingdate == 'true' && e.currentTarget.dataset.closedate != '') {
                                    html += "<span class='divider'> | </span>";
                                    html += "<span class='list-entry-ends'>" + e.currentTarget.dataset.closedate + "</span>";
                                }
                                html += "</div></div></div > ";
                                document.getElementById("map-card-container").innerHTML = html;
                                $('.container a.marker-link').click(function (e) {
                                    var pageType = pageInfoService.getCurrentPageType().type;
                                    var newQuery = location.search ?
                                        location.search + '&pagetype=' + pageType :
                                        '?pagetype=' + pageType;

                                    namespace('AgencyPages').router.navigate("/careers/" + agencyFolderName + "/jobs/" + e.target.dataset.jobId + "/" + e.target.dataset.jobTitle + newQuery, true, false, null, {
                                        id: e.target.dataset.jobId,
                                        title: e.currentTarget.dataset.classification,
                                        tab: 1
                                    });
                                });
                            }

                            function openPopupkeydown(e) {
                                if (e.key === 'Enter' || e.keyCode === 13) {
                                    openPopup(parseInt(e.target.dataset.clusterid), parseInt(e.target.dataset.pointcount));
                                }
                            }

                            function openPopupClick(e) {
                                isOpenPopup = true;
                                if (isMapMobile == false) {
                                    openPopup(parseInt(e.currentTarget.dataset.clusterid),
                                        parseInt(e.currentTarget.dataset.pointcount)
                                    );
                                }
                                else {
                                    openMobileCards(parseInt(e.currentTarget.dataset.clusterid),
                                        parseInt(e.currentTarget.dataset.pointcount)
                                    );
                                }
                            }

                            map.on('mouseenter', 'clusters', function () {
                                map.getCanvas().style.cursor = 'pointer';
                            });
                            map.on('mouseleave', 'clusters', function () {
                                map.getCanvas().style.cursor = '';
                            });
                            let start;

                            map.on('click', (e) => {
                                if (isMapMobile) {
                                    if (!isSingleMarkerClicked) {
                                        clearAllCards();
                                    }
                                    isSingleMarkerClicked = false;
                                    jobZipCodes = [];
                                }
                            });

                            map.on('zoom', (e) => {

                                for (var popUp of document.getElementsByClassName("mapboxgl-popup")) {
                                    popUp.remove();
                                }
                            });

                            map.on('moveend', (e) => {
                                if (isMapMobile == false) {
                                    showVisibleMarkers();
                                }

                            });

                            function showVisibleMarkers() {

                                var bounds = map.getBounds(),
                                    count = 0;
                                jobZipCodes = [];
                                var clusterSource = map.getSource('jobs');
                                for (var id in markersOnScreen) {
                                    var marker = markersOnScreen[id];
                                    var features = clusterSource.getClusterLeaves(parseInt(marker._element.dataset.clusterid), parseInt(marker._element.dataset.pointcount), 0).serialize().data.features;
                                    for (var i = 0; i < features.length; i++) {
                                        if (bounds.contains(features[i].geometry.coordinates) === true) {
                                            jobZipCodes.push(features[i].properties.jobzipcode);
                                        }
                                    }
                                }

                                jobZipCodes.sort(function (a, b) { return a - b });

                                jobZipCodes = jobZipCodes.filter((item, i, ar) => ar.indexOf(item) === i);
                                if (!isFlyTo) {
                                    showOverlay();
                                    loadJobs(jobsContainer, currentParams.jobtitle, null, currentParams.sort, currentParams.filters, false);
                                }
                                isFlyTo = false;

                            }
                            $('.maplibregl-ctrl-top-right').css('z-index', 0);
                            $('.maplibregl-ctrl-compass').hide();
                            $('.maplibregl-ctrl-bottom-right').hide();

                            map.on('idle', () => {
                                if (isMapMobile == false) {
                                    if (isOpenPopup == false) {
                                        showVisibleMarkers();

                                    }

                                    isOpenPopup = false;
                                    const collection = document.getElementsByClassName("maplibregl-ctrl-top-right");
                                    $(collection[collection.length - 1]).css("z-index", 1);
                                    $(collection[collection.length - 1]).show();
                                }
                                else {
                                    hideOverlay();
                                }

                            });
                        });

                    }
                    else {
                        hideOverlay();
                        if (isMapsOptionSelected()) {
                            $("#closeMap").removeClass("hidden");
                            $("#openMap").addClass("hidden");
                            $('.action-grid-view-container').hide();
                            $('.action-list-view-container').hide();
                            $('#mapsDiv').css('padding', '0px');
                            $('.maplibregl-ctrl-top-right').css('z-index', 1);
                        }
                        else {
                            $("#closeMap").addClass("hidden");
                            $("#openMap").removeClass("hidden");
                            $('.action-grid-view-container').show();
                            $('.action-list-view-container').show();
                        }
                        $('#number-found-items').css("right", "310px");
                        $(".vertical-line").show();
                        $(".maplibregl-canvas-container").css("position", "absolute");
                        if (response.isMapSearchEnable == false) {
                            $("#closeMap").addClass("hidden");
                            $("#openMap").addClass("hidden");
                            $('.action-grid-view-container').show();
                            $('.action-list-view-container').show();
                            $('#number-found-items').css("right", "300px");
                            $('#mapsDiv').hide();
                            sessionStorage.setItem("MapsSelected", false);
                            loadJobs(jobsContainer, keywords, null, sort, filters);
                        }
                    }

                }
                else {
                    hideOverlay();
                    if (isMapsOptionSelected()) {
                        $("#closeMap").removeClass("hidden");
                        $("#openMap").addClass("hidden");
                        $('.action-grid-view-container').hide();
                        $('.action-list-view-container').hide();
                        $('#mapsDiv').css('padding', '0px');
                        $('.maplibregl-ctrl-top-right').css('z-index', 1);
                    }
                    else {
                        $("#closeMap").addClass("hidden");
                        $("#openMap").removeClass("hidden");
                        $('.action-grid-view-container').show();
                        $('.action-list-view-container').show();
                    }
                    $("#closeMap").addClass("hidden");

                    $("#openMap").removeClass("hidden");
                    if (isMapMobile) {
                        $(".maps-open-button").removeClass("hidden");
                        $(".jobs-open-button").addClass("hidden");
                    }
                    $('.action-grid-view-container').show();
                    $('.action-list-view-container').show();
                    $('#number-found-items').css("right", "310px");
                    $(".vertical-line").show();
                    $(".maplibregl-canvas-container").css("position", "absolute");
                    if (response.isMapSearchEnable == false) {
                        $("#closeMap").addClass("hidden");
                        $("#openMap").addClass("hidden");
                        $('.action-grid-view-container').show();
                        $('.action-list-view-container').show();
                        $('#number-found-items').css("right", "300px");
                        $('#mapsDiv').hide();
                        sessionStorage.setItem("MapsSelected", false);
                        loadJobs(jobsContainer, keywords, null, sort, filters);
                    }
                }
            });

    }

    var colors = ['#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c'];


    function clearAllCards() {
        if (isMapMobile) {
            const myNode = document.getElementById("map-card-container");
            while (myNode.firstChild) {
                myNode.removeChild(myNode.lastChild);
            }
            jobZipCodes = [];
            $("#map-card-container").css("height", "0px");
        }
    }

    function createDonutChart(props) {
        var offsets = [];
        var counts = [
            props.point_count

        ];
        var total = 0;
        for (var i = 0; i < counts.length; i++) {
            offsets.push(total);
            total += counts[i] == undefined ? 0 : counts[i];
        }
        var fontSize =
            total >= 1000 ? 22 : total >= 100 ? 20 : total >= 10 ? 18 : 16;
        var r = total >= 1000 ? 50 : total >= 100 ? 32 : total >= 10 ? 24 : 18;
        var r0 = Math.round(r * 0.6);
        var w = r * 2;
        var imgSrc = "";
        if (total == 0) {
            imgSrc = '/Content/Images/AgencyPages/Maps/bluepin.png';
        }
        else if (total > 20) {
            imgSrc = '/Content/Images/AgencyPages/Maps/bluepin-number.png';
        }
        else {
            imgSrc = '/Content/Images/AgencyPages/Maps/bluepin-number.png';
        }

        var rightMargin = "";
        if (total < 10) {
            rightMargin = "10px";
        }
        else if (total < 100) {
            rightMargin = "7px";
        }
        else {
            rightMargin = "4px";
        }


        var html = "";
        if (total > 0) {
            html =
                '<div tabindex="0" aria-label="' + total + ' jobs at this location" id=' + props.cluster_id + ' data-clusterid=' + props.cluster_id + ' data-pointcount=' + props.point_count + '><img id=' + props.cluster_id + ' aria-label="' + total + ' jobs at this location" src="' + imgSrc + '">';

            html +=
                '<div style="position: absolute;bottom: 12px;right:' + rightMargin + ';font-size:x-small;">' +
                total.toLocaleString() +
                '</div></img></div>';
        }
        else if (total == 0) {
            html =
                '<div tabindex="0" aria-label="Single job posting at this location" id=' + props.mapClusterId + ' data-jobid=' + props.jobid + ' data-jobtitle=' + props.jobtitle + ' data-classification="' + props.classification + '"  data-latitude=' + props.latitude + ' data-longitude=' + props.longitude + ' data-jobzipcode=' + props.jobzipcode + ' data-location="' + props.location + '" data-jobtype="' + props.jobtype + '" data-salaryinfo="' + props.salaryinfo + '" data-category="' + props.category + '" data-departmentcustomlabel="' + props.departmentcustomlabel + '" data-department="' + props.department + '" data-examtype="' + props.examtype + '" data-divisioncustomlabel="' + props.divisioncustomlabel + '" data-division="' + props.division + '" data-remoteworkoption="' + props.remoteworkoption + '" data-issalaryvisible="' + props.issalaryvisible + '" data-opendate="' + props.opendate + '" data-showclosingdate="' + props.showclosingdate + '"  data-closedate="' + props.closedate + '" data-isnew="' + props.isnew + '"><img id=' + props.jobid + ' aria-label="Single job posting at this location" src="' + imgSrc + '">';
        }

        var el = document.createElement('div');
        el.innerHTML = html;
        return el.firstChild;
    }

    function checkIfNotFoundAndAdjust(keywords) {

        if ($('.jobs-not-found-container').length && !keywords && !filters && !isMapsOptionSelected()) {
            if (isTransferJobs() || isPromotionalJobs()) {
                searhContainer.addClass('inactive');
            }
        }

    }

    function checkIfNotFoundAndAdjustForMapsMobile(keywords) {

        if (mapJobsCount <= 0 && !keywords && !filters) {
            if (isTransferJobs() || isPromotionalJobs()) {
                searhContainer.addClass('inactive');
            }
        }

    }

    function isTransferJobs() {
        return pageInfoService.getCurrentPageType().type == pageInfoService.getPageTypes().transferJobs.type;
    }

    function isPromotionalJobs() {
        return pageInfoService.getCurrentPageType().type == pageInfoService.getPageTypes().promotionalJobs.type;
    }

    function updateNumberFound() {
        var jobsCount = $('#job-postings-number').text() || 0;
        gJobs.screenReadersService.applyNvdaAriaLiveFix(numberFound, jobsCount + ' jobs found');
    }

    function notifyShowedItemsCount() {
        var jobsCount = $('#job-postings-number').text() || 0;
        var $showItemsCount = $('#show-items-count');
        var lowRange = $('.pager-container-normal .items-div span:first-child').text();
        var topRange = $('.pager-container-normal .items-div span:last-child').text();

        $showItemsCount.text('');

        setTimeout(function () {
            if (jobsCount != 0) {
                lowRange = $.isNumeric(lowRange) ? lowRange : 1;
                topRange = $.isNumeric(topRange) ? topRange : jobsCount;
                $showItemsCount.text('Showing ' + lowRange + '-' + topRange + ' of ' + jobsCount + ' jobs');
            }
        }, 500);
    }

    function adjustCategoriesList() {

        $('.categories-list > span').each(function () {

            var $this = $(this);
            var fullText = $this.text();

            if (fullText.length > MAX_CATEGORIES_LENGTH) {

                var words = fullText.split('/');

                var resultCategories = words[0];

                if (words.length > 1) {
                    var counter = 1;
                    while (resultCategories.length + words[counter].length < MAX_CATEGORIES_LENGTH) {
                        resultCategories += '/' + words[counter];
                        counter++;
                    }

                    resultCategories += '... ';
                }

                $this.text(resultCategories);

                // Add link for showing all categories
                var $showAllCategoriesLink = $('<a>show all</a>');
                $this.after($showAllCategoriesLink);
                $showAllCategoriesLink.on('click', function () {
                    $this.text(fullText);
                    $(this).remove();
                });
            }
        });
    }

    //initialize tooltips for sortable table columns and social media buttons
    function initPopovers($jobsContainer) {
        $jobsContainer.find('[data-toggle="popover"]').popover().click(function () {
            $(this).popover('hide');
        });
    }
    function ClearFeatures() {
        if (globalMap != null && globalMap != undefined) {
            var featuresToUpdate = globalMap.querySourceFeatures('jobs');
            for (var i = 0; i < featuresToUpdate.length; i++) {
                if (featuresToUpdate[i].properties.cluster_id) {
                    var mapClusterImage = document.getElementById(featuresToUpdate[i].properties.cluster_id.toString());
                    if (mapClusterImage != null && mapClusterImage != undefined) {
                        mapClusterImage.innerHTML = mapClusterImage.innerHTML.replace("redpin", "bluepin-number")
                    }
                }
                else {
                    var mapClusterImage = document.getElementById(featuresToUpdate[i].properties.mapClusterId.toString());
                    if (mapClusterImage != null && mapClusterImage != undefined) {
                        mapClusterImage.innerHTML = mapClusterImage.innerHTML.replace("redpin2", "bluepin")
                    }
                }
            }
        }
    }
    function addHandlers($jobsContainer) {

        $jobsContainer.find('.pagination li > a').click(function (e) {

            var $this = $(this);

            var link = $this.attr('href');
            if (link) {
                var params = namespace('AgencyPages').getUrlParams(link);
                var newPage = params['page'];
                var currentQueryParams = url.get(window.location.search.slice(1), { array: true });
                currentQueryParams.page = newPage;
                var newQuery = '?' + url.buildget(currentQueryParams);

                AgencyPages.router.navigate(initialUrl + newQuery, true, null, null, currentQueryParams);
            }

            e.preventDefault();
        });
        $("#job-list-container").find('a#redirectJobDetails').on('click', function (event) {

            ClearFeatures();
            var featuresToUpdate = globalMap.querySourceFeatures('jobs');
            var latLong = JSON.parse(event.target.dataset.latlong);
            mapHighlightLatLong = latLong;
            mapHighlightJobId = event.target.dataset.jobid;
            co_ords = latLong;
            for (var j = 0; j < latLong.length; j++) {
                var latlongString = latLong[j];
                var latLongValue = latlongString.split(',');
                var lat = latLongValue[0];
                var lng = latLongValue[1];
                coordinates = new maplibregl.LngLat(lng, lat);
                var isInsideBound = globalMap.getBounds().contains(coordinates);
                if (isInsideBound) {
                    if (coordinates != undefined && coordinates != '') {
                        let arrayFeatures = [];
                        for (var i = 0; i < featuresToUpdate.length; i++) {

                            var coords = featuresToUpdate[i].geometry.coordinates;
                            var props = featuresToUpdate[i].properties;
                            var FeatureLatLong = new maplibregl.LngLat(coords[0], coords[1]);
                            var distance = coordinates.distanceTo(FeatureLatLong);
                            arrayFeatures.push({
                                distance: distance,
                                feature: featuresToUpdate[i],

                            });

                        }
                        var smallest = arrayFeatures.sort((a, b) => a.distance - b.distance);

                        if (smallest[0].feature.properties.cluster_id != undefined) {

                            var image = document.getElementById(smallest[0].feature.properties.cluster_id.toString());
                            image.innerHTML = image.innerHTML.replace("bluepin-number", "redpin")
                            $('#' + smallest[0].feature.properties.cluster_id).focus();
                        }
                        else {
                            var image = document.getElementById(smallest[0].feature.properties.mapClusterId.toString());
                            image.innerHTML = image.innerHTML.replace("bluepin", "redpin2")
                            $('#' + smallest[0].feature.properties.mapClusterId).focus();
                        }
                    }
                }
            }
        });
        $("#job-list-container").find('a#redirectJobDetails').on('keydown', function (event) {
            if (isMapsOptionSelected()) {
                if (event.keyCode == 13) {
                    ClearFeatures();
                    var featuresToUpdate = globalMap.querySourceFeatures('jobs');
                    var latLong = JSON.parse(event.currentTarget.dataset.latlong);
                    mapHighlightLatLong = latLong;
                    mapHighlightJobId = event.target.dataset.jobid;
                    co_ords = latLong;
                    for (var j = 0; j < latLong.length; j++) {
                        var latlongString = latLong[j];
                        var latLongValue = latlongString.split(',');
                        var lat = latLongValue[0];
                        var lng = latLongValue[1];
                        coordinates = new maplibregl.LngLat(lng, lat);
                        var isInsideBound = globalMap.getBounds().contains(coordinates);
                        if (isInsideBound) {
                            if (coordinates != undefined && coordinates != '') {
                                let arrayFeatures = [];
                                for (var i = 0; i < featuresToUpdate.length; i++) {

                                    var coords = featuresToUpdate[i].geometry.coordinates;
                                    var props = featuresToUpdate[i].properties;
                                    var FeatureLatLong = new maplibregl.LngLat(coords[0], coords[1]);
                                    var distance = coordinates.distanceTo(FeatureLatLong);
                                    arrayFeatures.push({
                                        distance: distance,
                                        feature: featuresToUpdate[i],

                                    });

                                }
                                var smallest = arrayFeatures.sort((a, b) => a.distance - b.distance);

                                if (smallest[0].feature.properties.cluster_id != undefined) {

                                    var image = document.getElementById(smallest[0].feature.properties.cluster_id.toString());
                                    image.innerHTML = image.innerHTML.replace("bluepin-number", "redpin")
                                    $('#' + smallest[0].feature.properties.cluster_id).focus();
                                }
                                else {
                                    var image = document.getElementById(smallest[0].feature.properties.mapClusterId.toString());
                                    image.innerHTML = image.innerHTML.replace("bluepin", "redpin2")
                                    $('#' + smallest[0].feature.properties.mapClusterId).focus();
                                }
                            }
                        }
                    }
                }
            }
        });
        $jobsContainer.find('a.item-details-link').on('click', function (event) {
            isLinkOpenFromDesktopMapPopUp = false;
            isLinkOpenFromMobileMapPopUp = false;
            var $this = $(this);

            var jobId = $this.closest('li, td').data('jobId');
            var jobTitle = $this.text();
            var departmentName = $this.data('department-name');

            var pageType = pageInfoService.getCurrentPageType().type;
            var newQuery = location.search ?
                location.search + '&pagetype=' + pageType :
                '?pagetype=' + pageType;

            namespace('AgencyPages').router.navigate($this.attr('href') + newQuery, true, false, null, {
                id: jobId,
                title: jobTitle,
                tab: 1
            });

            trackJobPageView(jobTitle, departmentName);
            let tablists = document.querySelectorAll('[role=tablist]');
            for (let i = 0; i < tablists.length; i++) {
                new TabsManual(tablists[i]);
            }

            event.preventDefault();
        });

        $jobsContainer.find('.search-results-grid-container thead a[href]').on('click', function (event) {
            var $el = $(event.currentTarget),
                sortBy = $el.data('sort-type'),
                sortType;

            if (sortBy) {
                var router = AgencyPages.router;

                var $sortEl = $el.find('.sort-el');

                if ($sortEl.hasClass('sort-up')) {
                    sortType = '|Descending';
                } else if ($sortEl.hasClass('sort-down')) {
                    sortType = null;
                } else {
                    sortType = '|Ascending';
                }

                sort = !sortType ? null : sortBy + sortType;

                var currentFilters = filters || {};
                $.extend(currentFilters, { sort: sort });
                if (keywords) {
                    $.extend(currentFilters, { keywords: keywords });
                }

                var query = url.buildget(currentFilters);

                router.navigate(initialUrl + '?' + query, false);

                $(document).trigger('SearchPage:sort', sort);
                $(document).trigger('FilterFlyout:sortByChanged', sort);

                $(document).one(Events.CommonEventsNames.JobsListLoaded, function (event) {
                    $('a[data-sort-type="' + sortBy + '"]').focus();
                });
            }
        });
    }

    function showOverlay() {
        overlay.show();
        if (isMapMobile) {
            overlay.css("z-index", 4);
            $('html, body').animate({ scrollTop: SCROLL_TOP }, "fast");
            $('body').css('overflow-y', 'hidden');
        }
        else {
            overlay.css("z-index", 1);
            if (isMapsOptionSelected() && !isMapMobile) {
                $(".filter-flyout-overlay").show();
            }
        }
    }

    function hideOverlay() {
        overlay.hide();
        overlay.css("z-index", -1);
        if (isMapMobile) {
            $('html, body').animate({ scrollTop: SCROLL_TOP }, "fast");
            $('body').css('overflow-y', 'scroll');
        }
        $(".filter-flyout-overlay").hide();
    }

    function hideAutoSuggestion() {
        var searchFieldAutoSuggestionContainer = $('.ui-autocomplete.ui-menu.popover.small-autocomplete');
        if (searchFieldAutoSuggestionContainer
            && searchFieldAutoSuggestionContainer.length > 0
            && $(window).width() > maxMobileScreenWidth) {
            searchFieldAutoSuggestionContainer.hide();
        }
    }

    //check if we've already searched for this keyword and have same search results
    function hasSameKeywords(newKeywords) {
        return keywords === decodeURI(newKeywords);
    }



    function searchJobs(newKeywords) {
        hideAutoSuggestion();

        if (hasSameKeywords(newKeywords)) {
            return;
        }

        keywords = newKeywords;
        searchInput.val(keywords);

        // Sort by relevance by default for search.
        sort = null;

        if (keywords == '') {
            sort = defaultSortingOrder;
        }

        $(document).trigger('FilterFlyout:sortByChanged', sort);
        clearAllCards();
        loadJobs(jobsContainer, keywords, null, sort, filters, true);

    }

    searchForm.on('submit', function (e) {
        e.preventDefault();

        hideAutoSuggestion();
        var inputValue = searchInput.val();

        if (hasSameKeywords(inputValue)) {
            if (keywords === '') {
                AgencyPages.searchPageHelper.showEmptySearchPopover(keywordSearchInput, searchForm, buttonLink);
            }

            return;
        }

        $(document).one(Events.CommonEventsNames.JobsListLoaded, function () {
            let notification = !!inputValue ? "Search by " + inputValue + " keyword is applied" : "Search by keyword is removed";
            $("#keyword-search-input").focus();
            $("#aria-live-message-container").text('');
            setTimeout(function () {
                gJobs.screenReadersService.setAriaLiveNotification(notification, $("#aria-live-message-container"), false);
            }, 500);
        });

        if (filters) {
            if (filters.classspecificationscodes) {
                let params = '';
                for (let i = 0; i < filters.classspecificationscodes.length; i++) {
                    params += '&classspecificationscodes[' + i + ']=' + encodeURIComponent(filters.classspecificationscodes[i]);
                }
                AgencyPages.router.navigate(initialUrl + '?' + url.buildget({ keywords: inputValue }) + params, null, null, null, { keywords: inputValue });
            }
            else {
                AgencyPages.router.navigate(initialUrl + '?' + url.buildget({ keywords: inputValue }), null, null, null, { keywords: inputValue });
            }
        }
        else {
            AgencyPages.router.navigate(initialUrl + '?' + url.buildget({ keywords: inputValue }), null, null, null, { keywords: inputValue });
        }
    });

    actionListView.on('click', function (e) {
        listGridViewService.showList();
        gJobs.screenReadersService.setAriaLiveNotification("Search results are shown in list view.");
        notifyShowedItemsCount();
    });

    $("#openMap").on('click', function (e) {
        showOverlay();
        $('html, body').animate({ scrollTop: SCROLL_TOP }, "fast");
        $('#title-bar').hide();
        $('.job-search-header-container').hide();
        $('body').css('overflow-y', 'hidden');
        $('#manage-bar').css('margin-top', '70px');
        $('footer').hide();
        $('#jobsdiv').css("height", "85vH");
        $('#mapsDiv').css("height", "85vH");
        $('.maplibregl-canvas').css("height", "85vH");


        var newPage = "1";
        var currentQueryParams = url.get(window.location.search.slice(1), { array: true });
        currentQueryParams.page = newPage;
        var newQuery = '?' + url.buildget(currentQueryParams);

        AgencyPages.router.navigate(initialUrl + newQuery, true, null, null, currentQueryParams);


        loadMaps(jobsContainer, keywords, null, sort, filters, true);
        $('#mapsDiv').css("display", "block");
        $('#jobsdiv').css("width", "50%");
        $('#jobsdiv').css("overflow-y", "auto");

        $('.action-grid-view-container').hide();
        $('.action-list-view-container').hide();
        $("#closeMap").removeClass("hidden");
        $("#openMap").addClass("hidden");
        $(".maps-open-button").addClass("hidden");
        $(".vertical-line").hide();
        $('#number-found-items').css("right", "300px");
        sessionStorage.setItem("MapsSelected", true);
        $('#jobsdiv').css("margin-right", "10px");
        $('#jobsdiv').css("margin-left", "10px");
        $('.job-listing-container').css("margin-right", "10px");
        $('.search-results-container').css('margin-top', '0px');
        $('.items-div').css("margin-right", "10px");
        $('.listing-title').css('padding-top', '0px');

        setTimeout(function () {
            gJobs.screenReadersService.setAriaLiveNotification("Map view is opened.", $("#aria-live-message-container"), false);
        }, 500);
    });

    $(".maps-open-button").on('click', function (e) {
        if (isMapMobile) {
            $(".job-search-header-container").css("display", "none");
            gJobs.screenReadersService.setAriaLiveNotification("Search results are shown in list view.");
            notifyShowedItemsCount();
            showOverlay();
            clearAllCards();
            loadMaps(jobsContainer, keywords, null, sort, filters, true);
            $('#mapsDiv').css("display", "block");
            $('#jobsDiv').css("display", "none");
            $("footer").css("display", "none");
            $("#closeMap").addClass("hidden");
            $("#openMap").addClass("hidden");
            $(".jobs-open-button").removeClass("hidden");
            $(".maps-open-button").addClass("hidden");
            $(".vertical-line").hide();
            $('#number-found-items').css("right", "300px");
            $('.maplibregl-canvas').css("height", "85vH");
            $('#mapsDiv').css("height", "85vH");
            sessionStorage.setItem("MapsSelected", true);
            $('.job-listing-container').css("margin-right", "10px");
            $('.search-results-container').css('margin-top', '0px');
            $('.items-div').css("margin-right", "10px");
            $('.listing-title').css('padding-top', '0px');
            gJobs.screenReadersService.setAriaLiveNotification("Map view is opened");
        }
    });

    $("#closeMap").on('click', function (e) {
        coordinates = '';
        mapHighlightLatLong = '';
        ClearFeatures();
        $('#title-bar').show();
        $('.job-search-header-container').show();
        $('body').css('overflow-y', 'auto');
        $('#manage-bar').css('margin-top', '0px');
        $('footer').show();


        var newPage = "1";
        var currentQueryParams = url.get(window.location.search.slice(1), { array: true });
        currentQueryParams.page = newPage;
        var newQuery = '?' + url.buildget(currentQueryParams);

        AgencyPages.router.navigate(initialUrl + newQuery, true, null, null, currentQueryParams);

        $('#mapsDiv').css("display", "none");
        $('#jobsdiv').css("display", "block");
        $('#jobsdiv').css("width", "100%");
        $('#jobsdiv').css("overflow-y", "hidden");
        $('#jobsdiv').css("height", "100%");
        $('#jobsdiv').css("margin-right", "0px");
        $('#jobsdiv').css("margin-left", "0px");
        $('.action-grid-view-container').show();
        $('.action-list-view-container').show();
        listGridViewService.showCurrentViewRegardingUserSettings(userSettingsService.getSettings());
        $("#closeMap").addClass("hidden");
        $("#openMap").removeClass("hidden");
        $(".vertical-line").show();
        $('#number-found-items').css("right", "310px");
        sessionStorage.setItem("MapsSelected", false);
        $('.reset-button').focus();
        $('.search-results-container').css('margin-top', '18px');
        $('.listing-title').css('padding-top', '10px');
        $('.job-listing-container').css("margin-right", "0px");
        $('.items-div').css("margin-right", "0px");
        coordinates = '';
        if (globalMap != null) {
            globalMap.remove();
            globalMap = null
        }



        gJobs.screenReadersService.setAriaLiveNotification("Map view is closed");
        loadJobs(jobsContainer, keywords, null, sort, filters);
    });
    $(".jobs-open-button").on('click', function (e) {
        $(".job-search-header-container").css("display", "block");

        $('#mapsDiv').css("display", "none");
        $('#jobsdiv').css("display", "block");
        clearAllCards();

        listGridViewService.showCurrentViewRegardingUserSettings(userSettingsService.getSettings());
        $("#closeMap").addClass("hidden");
        $("#openMap").addClass("hidden");
        if (isMapMobile) {
            $(".maps-open-button").removeClass("hidden");
            $(".jobs-open-button").addClass("hidden");
        }
        $(".vertical-line").show();
        $('#number-found-items').css("right", "310px");
        sessionStorage.setItem("MapsSelected", false);
        $('.search-results-container').css('margin-top', '18px');
        $('.listing-title').css('padding-top', '10px');
        $('.job-listing-container').css("margin-right", "0px");
        $('.items-div').css("margin-right", "0px");
        $("footer").css("display", "block");
        $('#keyword-search-input').focus();
        coordinates = '';
        if (globalMap != null) {
            globalMap.remove();
            globalMap = null
        }
        gJobs.screenReadersService.setAriaLiveNotification("Map view is closed");
        loadJobs(jobsContainer, keywords, null, sort, filters);

    });

    actionGridView.on('click', function (e) {
        listGridViewService.showGrid();
        gJobs.screenReadersService.setAriaLiveNotification("Search results are shown in grid view.");
        notifyShowedItemsCount();
    });

    $(document).on('SearchPage:sort', function (e, sortType) {
        sort = sortType;
        coordinates = '';
        mapHighlightLatLong = '';
        ClearFeatures();
        loadJobs(jobsContainer, keywords, null, sort, filters);
    });

    $(document).on('SearchPage:filtersChanged', function (e, data) {
        filters = data.newfilters;
        clearAllCards();
        if (data.isChangeFromFlyout) {
            page = null;
        }
        coordinates = '';
        mapHighlightLatLong = '';
        loadJobs(jobsContainer, keywords, page, sort, filters, true);
    });

    function initJobFlyout() {

        var agencyPagesJobListAdapter = (function () {
            /* This adapter still needs to be improved, because it counts only jobs listed on the current page
               todo: check whether there are jobs on other pages, and think of a way to navigate to a different page,
                     flyout may notify this adapter by triggering a common job-changed event, or an extra method may be addded into the adapter
               */

            var currentNavigationStatus = '';

            var getJobLi = function (id, position) {
                return $('.job-listing-container li[data-job-id="' + id + '"]')[position]('li[data-job-id]');
            };

            var getJobListFromMapDesktopPopup = function (id, position) {
                if (position == 'prev') {
                    return $('.map-container li[data-job-id="' + id + '"]').first()[position]('li[data-job-id]');
                }
                else {
                    return $('.map-container li[data-job-id="' + id + '"]').last()[position]('li[data-job-id]');
                }
            };

            var getJobListFromMapMobilePopup = function (id, position) {
                if (position == 'prev') {
                    return $('.container div.map-td[data-job-id="' + id + '"]').first()[position]('div.map-td[data-job-id]');
                }
                else {
                    return $('.container div.map-td[data-job-id="' + id + '"]').last()[position]('div.map-td[data-job-id]');
                }
            };

            function clickJobLink($jobLink) {
                gJobs.focusService.restoreFocus();
                $jobLink.click();
                var jobHref = $jobLink.attr('href');
                var $visibleJobLink = $('[href="' + jobHref + '"]:visible').first();
                gJobs.focusService.replaceLastElement($visibleJobLink);
            }

            return {
                hasNextJob: function (id) {
                    if (isLinkOpenFromDesktopMapPopUp) {
                        return !!getJobListFromMapDesktopPopup(id, 'next').length;
                    }
                    if (isLinkOpenFromMobileMapPopUp) {
                        return !!getJobListFromMapMobilePopup(id, 'next').length;
                    }
                    if (!isLinkOpenFromDesktopMapPopUp && !isLinkOpenFromMobileMapPopUp) {


                        var currentPage = currentParams.page || 1;
                        var jobsNumber = $('#job-postings-number').text();
                        var assumedJobsNumber = JOBS_PER_PAGE * currentPage;

                        return !!getJobLi(id, 'next').length || assumedJobsNumber < jobsNumber;
                    }
                },
                hasPreviousJob: function (id) {
                    if (isLinkOpenFromDesktopMapPopUp) {
                        return !!getJobListFromMapDesktopPopup(id, 'prev').length;
                    }
                    if (isLinkOpenFromMobileMapPopUp) {
                        return !!getJobListFromMapMobilePopup(id, 'prev').length;
                    }
                    if (!isLinkOpenFromDesktopMapPopUp && !isLinkOpenFromMobileMapPopUp) {
                        var currentPage = currentParams.page || 1;

                        return !!getJobLi(id, 'prev').length || currentPage > 1;
                    }
                },
                getNextJob: function (id) {
                    if (isLinkOpenFromDesktopMapPopUp) {
                        var $nextJobLi = getJobListFromMapDesktopPopup(id, 'next');
                        var $nextJobLink = null;
                        $nextJobLink = $nextJobLi.find('a.marker-link');

                        currentNavigationStatus = 'Next job';
                        clickJobLink($nextJobLink);
                    }
                    if (isLinkOpenFromMobileMapPopUp) {
                        var $nextJobLi = getJobListFromMapMobilePopup(id, 'next');
                        var $nextJobLink = null;
                        $nextJobLink = $nextJobLi.find('a.marker-link');

                        currentNavigationStatus = 'Next job';
                        clickJobLink($nextJobLink);
                    }
                    if (!isLinkOpenFromDesktopMapPopUp && !isLinkOpenFromMobileMapPopUp) {
                        var $nextJobLi = getJobLi(id, 'next');
                        var $nextJobLink = $nextJobLi.find('a.item-details-link');
                        currentNavigationStatus = 'Next job';

                        if (!$nextJobLink.length) {
                            var currentPage = currentParams.page || 1;
                            var nextPage = currentPage + 1;
                            ClearFeatures();
                            loadJobs(jobsContainer, currentParams.jobtitle,
                                nextPage, currentParams.sort, currentParams.filters)
                                .then(function () {
                                    OnlineApp.Services.tabIndexService.disableTabIndex({
                                        containerSelector: jobListContainerSelector
                                    });

                                    $nextJobLi = $('.job-listing-container li.list-item').first();
                                    $nextJobLink = $nextJobLi.find('a.item-details-link');
                                    clickJobLink($nextJobLink);
                                });

                        } else {
                            clickJobLink($nextJobLink);
                        }
                    }
                },
                getPreviousJob: function (id) {
                    if (isLinkOpenFromDesktopMapPopUp) {
                        var $prevJobLi = getJobListFromMapDesktopPopup(id, 'prev')

                        var $prevJobLink = null;
                        $prevJobLink = $prevJobLi.find('a.marker-link');

                        currentNavigationStatus = 'Previous job';
                        clickJobLink($prevJobLink);
                    }
                    if (isLinkOpenFromMobileMapPopUp) {
                        var $prevJobLi = getJobListFromMapMobilePopup(id, 'prev');
                        var $prevJobLink = null;
                        $prevJobLink = $prevJobLi.find('a.marker-link');

                        currentNavigationStatus = 'Previous job';
                        clickJobLink($prevJobLink);
                    }
                    if (!isLinkOpenFromDesktopMapPopUp && !isLinkOpenFromMobileMapPopUp) {
                        var $prevJobLi = getJobLi(id, 'prev');
                        var $prevJobLink = $prevJobLi.find('a.item-details-link');
                        currentNavigationStatus = 'Previous job';

                        if (!$prevJobLink.length) {
                            var currentPage = currentParams.page;
                            var prevPage = currentPage - 1 || 1;
                            ClearFeatures();
                            loadJobs(jobsContainer, currentParams.jobtitle,
                                prevPage, currentParams.sort, currentParams.filters)
                                .then(function () {
                                    OnlineApp.Services.tabIndexService.disableTabIndex({
                                        containerSelector: jobListContainerSelector
                                    });

                                    $prevJobLi = $('.job-listing-container li.list-item').last();
                                    $prevJobLink = $prevJobLi.find('a.item-details-link');
                                    clickJobLink($prevJobLink);
                                });

                        } else {
                            clickJobLink($prevJobLink);
                        }
                    }
                },
                getJobNavigationStatus: function () {
                    return currentNavigationStatus;
                },
                resetJobNavigationStatus: function () {
                    currentNavigationStatus = '';                    
                }
            };

        })();

        var jobFlyout = new JobFlyout({ jobListAdapter: agencyPagesJobListAdapter });

        namespace('AgencyPages').jobFlyout = jobFlyout;
    }

    function restoreJobFlyout(params) {
        var jobUrl = '';
        var jobId = '';
        var currentUrlParts = pageInfoService.getCurrentUrlParts();
        var isDepartmentPage = pageInfoService.isDepartmentPage();
        var isJobDetails = false;
        var paramsCopy = {};

        if (params.jobId && params.tab && params.jobName) {
            jobId = params.jobId;
            jobUrl = '/' + currentUrlParts[1] + '/' + currentUrlParts[2];

            if (isDepartmentPage) {
                jobUrl += '/' + currentUrlParts[3];
            }

            jobUrl += '/jobs/' + params.jobId + '/' + params.jobName;

            if (params.tab == 2) {
                jobUrl += '/apply';

                if (params.jobDetails == 1) {
                    isJobDetails = true;
                    delete params.jobDetails;
                }
            }
            delete params.jobId;
            delete params.tab;
            delete params.jobName;
        }

        if (jobUrl) {
            $.extend(paramsCopy, params); // We need URL parametres without jobId, tab and jobName to restore exact state.
            // We need to wait for populating jobs list to make "Next Posting" and "Previous posting" buttons work properly.
            $(document).one(Events.CommonEventsNames.JobsListLoaded, function () {
                // todo: Find a better way to populate job title
                var $jobLink = $('[data-job-id="' + jobId + '"]').find('a.item-details-link:visible');
                var jobTitle = $jobLink.text();
                var departmentName = $jobLink.data('department-name');
                namespace('AgencyPages').router.navigate(jobUrl + '?' + url.buildget(paramsCopy), true, false, null,
                    {
                        jobTitle: jobTitle || ''
                    });

                $(document).on(Events.CommonEventsNames.GoogleAnalyticsTrackersInjected, function () {
                    trackJobPageView(jobTitle, departmentName);
                });
                $(document).trigger(Events.CommonEventsNames.JobDetailsLoaded);
            });

            if (isJobDetails) {
                // Waiting for loading OnlineApp and updating last completed step in it to load JobDetails flyout.
                $(document).one(OnlineApp.Events.CommonEventsNames.ApplicationRendered, function () {
                    namespace('AgencyPages').router.navigate(jobUrl + '/jobdetails', true, false, null, null, true);
                });
            }
        }
    }

    function trackJobPageView(jobTitle, departmentName) {
        if (jobTitle && departmentName) {
            gJobs.common.analytics.setProperties({
                properties: {
                    dimension8: jobTitle,
                    dimension9: departmentName
                },
                sendToAllTrackers: true
            });
        }

        gJobs.common.analytics.trackVirtualPageView({
            page: 'modal',
            title: 'Job Opportunities | ' + jobTitle,
            sendToAllTrackers: true
        });
    }

    function applyQueryParametres(params) {
        restoreJobFlyout(params);

        keywords = params.keywords || '';
        keywords = keywords.replace('+', ' ');
        searchInput.val(keywords);

        if (params.sort) {
            sort = params.sort;
            delete params.sort;
        }

        if (params.page) {
            page = params.page;
            delete params.page;
        }

        if (params.keywords) {
            delete params.keywords;
        }

        if (Object.keys(params).length !== 0) {
            filterflyout.applyFilters(params);
        } else {
            coordinates = '';
            mapHighlightLatLong = '';
            loadJobs(jobsContainer, keywords, page, sort, filters, true);

        }
    }


    $(document).ready(function () {
        defaultSortingOrder = searhContainer.data('default-sort-type');
        initJobFlyout();
        initFilterFlyout();
        initCanvassFlyout();
        isMapMobile = $('#map-card-container').is(":visible");
        // Decode escaped '[' & ']' to get correct arrays of parameters.
        var params = url.get(decodeURI(window.location.search.slice(1)), { array: true });

        // Don't use default sort order if we have keywords (default to relevance for search by keyword)
        if (!params.keywords) {
            sort = defaultSortingOrder;
        }

        var settingsString = sessionStorage.getItem("MapsSelected");
        if (settingsString == undefined || settingsString == null || settingsString == "") {
            sessionStorage.setItem("MapsSelected", false);
        }
        settingsString = sessionStorage.getItem("MapsSelected");
        var isChatBotOpen = $("#chatbase-bubble-button").is(":visible");
        if (settingsString == "true") {
            $("#closeMap").removeClass("hidden");
            $("#openMap").addClass("hidden");

            if (isMapMobile) {

                $(".job-search-header-container").css("display", "none");
                $(".maps-open-button").addClass("hidden");
                $(".jobs-open-button").removeClass("hidden");
                $("footer").css("display", "none");
                $('#menu-container').css("z-index", 5);
                $('.maplibregl-canvas').css("height", "85vH");
                $('#mapsDiv').css("height", "85vH");
            }
            else {
                $('html, body').animate({ scrollTop: SCROLL_TOP }, "fast");
                $('#title-bar').hide();
                $('.job-search-header-container').hide();
                $('body').css('overflow-y', 'hidden');
                $('#manage-bar').css('margin-top', '70px');
                $('footer').hide();
                $('#jobsdiv').css("height", "85vH");
                $('#mapsDiv').css("height", "85vH");
                $('.maplibregl-canvas').css("height", "85vH");

            }
            $(".vertical-line").hide();
            $('.action-grid-view-container').hide();
            $('.action-list-view-container').hide();


            if (Object.keys(params).length) {
                applyQueryParametres(params);
            } else {
                loadMaps(jobsContainer, keywords, null, sort, filters, true);

            }
        }
        else {
            $('#menu-container').css("z-index", 2);
            $("#closeMap").addClass("hidden");
            $("#openMap").removeClass("hidden");
            if (isMapMobile) {
                $(".job-search-header-container").css("display", "block");
                $(".maps-open-button").removeClass("hidden");
                $(".jobs-open-button").addClass("hidden");
                $("footer").css("display", "block");
            }
            $(".vertical-line").show();
            $('.action-grid-view-container').show();
            $('.action-list-view-container').show();
            if (Object.keys(params).length) {
                applyQueryParametres(params);
            } else {
                coordinates = '';
                mapHighlightLatLong = '';
                loadJobs(jobsContainer, keywords, null, sort, filters);

            }
        }



        if (namespace('AgencyPages').router.isCurrentUrlMatchedToRoute('careersCanvassFormRoute') ||
            namespace('AgencyPages').router.isCurrentUrlMatchedToRoute('careersCanvassFormDepartmentRoute')) {
            History.Adapter.trigger(window, 'statechange');
        }

        $(document).trigger('FilterFlyout:sortByChanged', sort);

        $('.ui-autocomplete.ui-menu').on('click', '.ui-menu-item', function () {
            searchForm.trigger('submit');
        });

        $(window).on('scroll resize', function () {

            if (!isMapsOptionSelected()) {
                hideAutoSuggestion();
                listGridViewService.showCurrentViewRegardingUserSettings(userSettingsService.getSettings());

            }
        });

        $(window).on('resize', function () {
            clampJobDescriptions();
        });

        $(document).on(OnlineApp.Events.CommonEventsNames.ApplyTabOpened, function () {
            gJobs.skipToContentService.showOnNextTab();
        });

        if (gJobs.browserDetector.isIE()) {
            gJobs.pageTabNavigationService.enableScrollForElements(jobsContainer, '.item-details-link', '.list-item');
        }
        gJobs.pageTabNavigationService.adjustNavigationForFixedHeader($('body'));

    });

    namespace('AgencyPages').searchPage = {
        search: function (newKeywords) {
            newKeywords = newKeywords || '';
            searchJobs(newKeywords);
        },

        goToPage: function (newPageNumber) {
            if (page !== newPageNumber) {
                page = newPageNumber;
                coordinates = '';
                ClearFeatures();
                loadJobs(jobsContainer, keywords, newPageNumber, sort, filters);
                $('html, body').animate({ scrollTop: SCROLL_TOP }, "fast");
            }
        }
    };

})(window);
;
(function (window, undefined) {
    'use strict';

    function showEmptySearchPopover(keywordSearchInput, searchForm, buttonLink) {
        var $keywordSearchInput = $(keywordSearchInput || '#keyword-search-input');
        var $buttonLink = $(buttonLink || 'button.btn.btn-link');

        $keywordSearchInput.focus();
        $keywordSearchInput.popover('show');

        $keywordSearchInput.on('blur.emptySearchPopoverShown', function (e) {
            $keywordSearchInput.popover('hide');
            $keywordSearchInput.off('blur.emptySearchPopoverShown keydown.emptySearchPopoverShown');
        });

        $keywordSearchInput.on('keydown.emptySearchPopoverShown', function (e) {
            if (e.keyCode !== $.ui.keyCode.ENTER) {
                $keywordSearchInput.popover('hide');
                $keywordSearchInput.off('blur.emptySearchPopoverShown keydown.emptySearchPopoverShown');
            }
        });
    }

    function getKeywordsFromUrl() {
        var url = window.location.href;
        var urlKeywords = '';

        if (url) {
            urlKeywords = AgencyPages.getUrlParams(url).keywords || '';
        }

        return urlKeywords;
    }

    $(document).ready(function () {
        var $keywordSearchInput = '';
        if (document.getElementById("el-keyword-search-input")) {
            $keywordSearchInput = $("#el-keyword-search-input");
        }
        else if (document.getElementById("el-candidate-keyword-search-input")) {
            $keywordSearchInput = $("#el-candidate-keyword-search-input");
        }
        else {
            $keywordSearchInput = $("#keyword-search-input");
        }
        var $searchForm = $keywordSearchInput.closest('.search-form');
        var $clearFieldButton = $searchForm.find('.clear-field-button');
        var $searchStatus = $searchForm.find('.keyword-search-input-label .ui-helper-hidden-accessible');

        $keywordSearchInput.on('change keyup paste', function (e) {
            if ($keywordSearchInput.val() === '') {
                $keywordSearchInput.removeClass('filled');
                $clearFieldButton.hide();
            } else {
                $keywordSearchInput.addClass('filled');
                $clearFieldButton.show();
                if (e.keyCode === $.ui.keyCode.ENTER) {
                    $searchForm.trigger('submit');
                }
            }
        });

        if ($keywordSearchInput.val() !== '') {
            $clearFieldButton.show();
            $keywordSearchInput.addClass('filled');
        }
        
        $clearFieldButton.click(function () {
            var $kl = $keywordSearchInput.val();
            var numberOfJobsFoundText = $("#number-found-items").text();
            $keywordSearchInput.val('');            
            $searchStatus.text('');
            $keywordSearchInput.focus()
            $keywordSearchInput.trigger('change');
            $searchForm.submit();
            $keywordSearchInput.focus();
            if (numberOfJobsFoundText && numberOfJobsFoundText != "" && numberOfJobsFoundText != "0 jobs found") {
                if (numberOfJobsFoundText != "0 results found") {
                    setTimeout(function () {
                        gJobs.screenReadersService.setAriaLiveNotification("Search by keyword is removed. " + numberOfJobsFoundText, $("#aria-live-message-container"), false);
                    }, 500);
                }
            }
        });
    });

    namespace('AgencyPages').searchPageHelper = {
        showEmptySearchPopover: showEmptySearchPopover,
        getKeywordsFromUrl: getKeywordsFromUrl
    };
})(window)
;
(function (window, undefined) {

    /*  In pages with verbiages (like Class Specs, Jobs, Categories etc.)
        texts should be collapsed to the first two lines with an ability to expand them by clicking the 'show-more' button
    */

    var showMoreTemplate = '<span class="button-text">SHOW MORE</span><i class="icon icon-xs icon-chevron-down"></i>';
    var showLessTemplate = '<span class="button-text" aria-hidden="true">SHOW LESS</span><i class="icon icon-xs icon-chevron-up"></i>';

    var numberLinesShowing = 4;

    var $verbiage,
        $verbiageOverlay,
        $verbiageToggleButtonPanel,
        $verbiageToggleButton;

    function initVerbiageCollapsing(maxVisibleLineCount) {

        $verbiageOverlay = $('.verbiage-overlay');

        $verbiage = $verbiageOverlay.parent();
        $verbiageToggleButtonPanel = $('.verbiage-toggle-button-panel');
        $verbiageToggleButton = $verbiageToggleButtonPanel.find('.verbiage-toggle-button');

        var verbiageOverlayHtml = $("<div />").append($verbiageOverlay.clone()).html();
        $verbiageOverlay.replaceWith('');

        /* Most of the tags will be stripped on the back-end, but for now, removing line breaks here */
        var verbiageText = $verbiage.html() || '';

        $verbiage.html(verbiageText + verbiageOverlayHtml);
        $verbiageOverlay = $verbiage.find('.verbiage-overlay');

        var lineHeight = parseInt($verbiage.css('line-height'), 10);
        var visibleHeight = lineHeight * maxVisibleLineCount;


        // Function to restrict focusability of hidden elements
        function restrictFocusToVisibleContent() {
            var container = document.querySelector('.verbiage');
            if (container) {
               
                var allElements = container.querySelectorAll('*');
                // Select only focusable elements
                var focusableElements = container.querySelectorAll(
                    'a, button, input, textarea, select, [tabindex]'
                );

                allElements.forEach(function (element) {
                    if (container.classList.contains('collapsed')) {
                        var overlay = container.querySelector('.verbiage-overlay');
                        // Handle collapsed state: Hide elements outside the visible area
                        if (element.offsetTop > container.offsetHeight || element.offsetTop >= overlay.offsetTop) {
                            element.setAttribute('aria-hidden', 'true'); // Hide from screen readers
                        } else {
                            element.removeAttribute('aria-hidden'); // Make visible elements readable
                        }
                    } else {
                        // Handle expanded state: Restore visibility for all elements
                        element.removeAttribute('aria-hidden');
                    }
                });

                focusableElements.forEach(function (element) {
                    if (container.classList.contains('collapsed')) {
                        // Handle collapsed state: Make focusable elements outside the visible area unfocusable
                        if (element.offsetTop + element.offsetHeight > container.offsetHeight) {
                            element.setAttribute('tabindex', '-1'); // Make hidden elements unfocusable
                        } else {
                            element.removeAttribute('tabindex'); // Ensure visible elements are focusable
                        }
                    } else {
                        // Handle expanded state: Restore focusability of all focusable elements
                        element.removeAttribute('tabindex');
                    }
                });
            }
        }

        function focusFirstFocusableElement() {
            var container = document.querySelector('.verbiage'); // Select the .verbiage container
            if (container) {
                var focusableElements = container.querySelectorAll(
                    'a, button, input, textarea, select, [tabindex]:not([tabindex="-1"])'
                );

                // Focus the first focusable element
                if (focusableElements.length > 0) {
                    var firstElement = focusableElements[0];
                    firstElement.focus();
                }
                else {
                    $('.verbiage-toggle-button').focus();
                }
            }
        }

        $verbiageToggleButton.ready(function () {
            $verbiageToggleButton.attr("aria-label", "Show more content");

            // Restrict focusability of hidden elements
            restrictFocusToVisibleContent();
        });

        $verbiageToggleButton.on('click', function () {
            if ($verbiage.hasClass('collapsed')) {
                $verbiageToggleButton.blur();
                $verbiage.css('max-height', $verbiage.get(0).scrollHeight);
                $verbiage.removeClass('collapsed');

                $verbiageToggleButton.html(showLessTemplate);
                $verbiageToggleButton.attr("aria-label", "Show less content");
                $verbiageToggleButton.attr("role", "link");
                gJobs.screenReadersService.setAriaLiveNotification("Content is expanded.");

                // Move focus to the first visible focusable element
                setTimeout(function () {                    
                    focusFirstFocusableElement();
                    restrictFocusToVisibleContent();
                }, 500);
            } else {
                $verbiageToggleButton.blur();
                $verbiageToggleButton.attr("aria-label", "Show more content");
                $verbiageToggleButton.attr("role", "link");
                $verbiage.css('max-height', '');
                $verbiage.addClass('collapsed');

                $verbiageToggleButton.html(showMoreTemplate);
                gJobs.screenReadersService.setAriaLiveNotification("Content is collapsed");

                // Restrict focusability of hidden elements
                setTimeout(function () {
                    $verbiageToggleButton.focus();
                    restrictFocusToVisibleContent();
                }, 500);
            }
        });

        $(window).resize(resizeHandler);

        resizeHandler();

        function resizeHandler() {
            if ($verbiage.hasClass('collapsed')) {
                if ($verbiage.get(0).scrollHeight <= visibleHeight) {
                    $verbiageToggleButtonPanel.addClass('hidden');
                    $verbiageOverlay.addClass('hidden');
                } else {
                    $verbiageToggleButtonPanel.removeClass('hidden');
                    $verbiageOverlay.removeClass('hidden');
                }
            }
        }
    }

    $(document).ready(function () {

        initVerbiageCollapsing(numberLinesShowing);

    });

})(window);;

