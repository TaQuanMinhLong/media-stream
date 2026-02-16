use std::cell::RefCell;
use std::rc::Rc;

/// Shared JS listeners for READY / ERROR / STATE_UPDATE.
pub(crate) struct Listeners {
    pub(crate) on_state_update: Rc<RefCell<Option<js_sys::Function>>>,
    pub(crate) on_ready: Rc<RefCell<Option<js_sys::Function>>>,
    pub(crate) on_error: Rc<RefCell<Option<js_sys::Function>>>,
}

impl Listeners {
    pub(crate) fn new() -> Self {
        Self {
            on_state_update: Rc::new(RefCell::new(None)),
            on_ready: Rc::new(RefCell::new(None)),
            on_error: Rc::new(RefCell::new(None)),
        }
    }

    pub(crate) fn set_on_state_update(&self, callback: js_sys::Function) {
        *self.on_state_update.borrow_mut() = Some(callback);
    }

    pub(crate) fn set_on_ready(&self, callback: js_sys::Function) {
        *self.on_ready.borrow_mut() = Some(callback);
    }

    pub(crate) fn set_on_error(&self, callback: js_sys::Function) {
        *self.on_error.borrow_mut() = Some(callback);
    }
}
